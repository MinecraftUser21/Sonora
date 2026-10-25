"""Sonora: a small YouTube music downloader built on yt-dlp and pywebview."""
import ctypes
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from pathlib import Path

APP_NAME = 'Sonora'
VERSION = '1.3.0'
FROZEN = getattr(sys, 'frozen', False)
BASE = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
BIN = BASE / 'bin'
UI = BASE / 'ui'

DATA = Path(os.environ.get('APPDATA') or Path.home()) / APP_NAME
DATA.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = DATA / 'settings.json'
COOKIE_FILE = DATA / 'cookies.txt'
LOG_FILE = DATA / 'sonora.log'
WEBDATA = Path(os.environ.get('LOCALAPPDATA') or DATA) / APP_NAME / 'webview'
LIBRARY_NAME = '.sonora.json'

# A windowed exe has no console, so give stdout/stderr somewhere to go
if sys.stdout is None or sys.stderr is None:
    _log = open(LOG_FILE, 'a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

import mutagen  # noqa: E402
import webview  # noqa: E402
import yt_dlp  # noqa: E402
import yt_dlp.cookies  # noqa: E402
from anyascii import anyascii  # noqa: E402
from yt_dlp.postprocessor.common import PostProcessor  # noqa: E402
from yt_dlp.utils import DownloadCancelled, sanitize_filename  # noqa: E402

LOGIN_URL = ('https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true'
             '&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue'
             '%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fwww.youtube.com%252F')
LIKED = {
    'videos': 'https://www.youtube.com/playlist?list=LL',
    'music': 'https://music.youtube.com/playlist?list=LM',
}
AUTH_COOKIES = {'SAPISID', '__Secure-3PAPISID', 'LOGIN_INFO', 'SID'}

# Keep old and low-end PCs responsive: fewer parallel downloads, and only
# one or two ffmpeg conversions at a time since those are the CPU hogs
CPUS = os.cpu_count() or 2
WORKERS = 1 if CPUS <= 2 else 2 if CPUS <= 4 else 3
CONVERTERS = 1 if CPUS <= 6 else 2
LOW_END = CPUS <= 4

DEFAULTS = {
    'folder': str(Path.home() / 'Music' / APP_NAME),
    'pc_folder': str(Path.home() / 'Music' / APP_NAME),
    'format': 'mp3',
    'quality': '320',
    'skip_saved': True,
    'tidy': True,
    'sort': 'playlist',  # playlist | artist | genre | language | custom | none
    'genre': 'Pop',
    'language': 'auto',
    'custom': '',
    'genres': ['Pop', 'Hip-Hop', 'Rock', 'R&B', 'Electronic', 'Lo-fi', 'Classical', 'Devotional', 'Party', 'Chill'],
    'languages': ['English', 'Hindi', 'Bengali', 'Punjabi', 'Tamil', 'Telugu', 'Spanish', 'Korean', 'Japanese'],
    'customs': ['Road trip', 'Workout', 'Favourites'],
    'car': False,
    'car_numbers': True,
    'car_level': False,
    'auto_sync': True,  # plugging in a USB drive tops it up with only the songs it's missing
    'account': None,  # {'source': 'signin' | 'file' | <browser>, 'since': epoch}
    'theme': 'midnight',  # a built-in theme id from ui/themes.js, or the id of one of 'themes'
    'themes': [],  # your own: {'id', 'name', 'bg', 'surface', 'text', 'accent'}
    'theme_bg': '#000000',  # window colour before the page paints, so a light theme doesn't flash black
}
SETTING_KEYS = {'format', 'quality', 'skip_saved', 'tidy', 'sort', 'genre', 'language', 'custom',
                'car', 'car_numbers', 'car_level', 'auto_sync'}
BUCKETS = {'genre': 'genres', 'language': 'languages', 'custom': 'customs'}
HEX_COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
THEME_COLORS = ('bg', 'surface', 'text', 'accent')
MAX_THEMES = 40

FORMATS = {
    'mp3': ('bestaudio/best', 'mp3'),
    'm4a': ('bestaudio[ext=m4a]/bestaudio/best', 'm4a'),
    'opus': ('bestaudio[acodec=opus]/bestaudio/best', 'opus'),
}
SQUARE = "crop='if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"
# Car stereos choke on big or progressive cover art; 300 px baseline JPEG is safe
COVER_NORMAL = f'ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf "{SQUARE},scale=\'min(720,iw)\':-2"'
COVER_CAR = f'ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -pix_fmt yuvj420p -vf "{SQUARE},scale=300:300"'

SCRIPTS = [
    ('[ঀ-৿]', 'Bengali'), ('[਀-੿]', 'Punjabi'), ('[઀-૿]', 'Gujarati'),
    ('[଀-୿]', 'Odia'), ('[஀-௿]', 'Tamil'), ('[ఀ-౿]', 'Telugu'),
    ('[ಀ-೿]', 'Kannada'), ('[ഀ-ൿ]', 'Malayalam'), ('[ऀ-ॿ]', 'Hindi'),
    ('[가-힯ᄀ-ᇿ]', 'Korean'), ('[぀-ヿ]', 'Japanese'), ('[一-鿿]', 'Chinese'),
    ('[؀-ۿ]', 'Arabic'), ('[Ѐ-ӿ]', 'Russian'), ('[฀-๿]', 'Thai'),
    ('[֐-׿]', 'Hebrew'), ('[Ͱ-Ͽ]', 'Greek'),
]
LANG_CODES = {
    'en': 'English', 'hi': 'Hindi', 'bn': 'Bengali', 'pa': 'Punjabi', 'ta': 'Tamil', 'te': 'Telugu',
    'mr': 'Marathi', 'gu': 'Gujarati', 'kn': 'Kannada', 'ml': 'Malayalam', 'ur': 'Urdu', 'or': 'Odia',
    'es': 'Spanish', 'pt': 'Portuguese', 'fr': 'French', 'de': 'German', 'it': 'Italian', 'ko': 'Korean',
    'ja': 'Japanese', 'zh': 'Chinese', 'ar': 'Arabic', 'ru': 'Russian', 'tr': 'Turkish', 'id': 'Indonesian',
    'th': 'Thai', 'vi': 'Vietnamese', 'nl': 'Dutch', 'pl': 'Polish', 'ne': 'Nepali',
}
LANG_WORDS = [
    (r'\b(bollywood|hindi)\b', 'Hindi'), (r'\b(bangla|bengali|tollywood)\b', 'Bengali'),
    (r'\bpunjabi\b', 'Punjabi'), (r'\btamil|kollywood\b', 'Tamil'), (r'\btelugu\b', 'Telugu'),
    (r'\bmalayalam\b', 'Malayalam'), (r'\bkannada\b', 'Kannada'), (r'\bmarathi\b', 'Marathi'),
    (r'\b(k-?pop)\b', 'Korean'), (r'\b(j-?pop|anime)\b', 'Japanese'),
    (r'\b(reggaeton|latino|en español|video oficial)\b', 'Spanish'),
]
JUNK = re.compile(
    r'official|video|lyric|audio|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|\bm/?v\b|full song|oficial|explicit|'
    r'color coded|perf(ormance)?\b|from .+ movie|out now|premiere', re.I)
JUNK_PART = re.compile(
    r'(official|music|lyrics?|lyrical|video|audio|full|song|hd|hq|4k|visuali[sz]er|m/?v|out now|new|[\s&/])+', re.I)

# What counts as a song when cross-referencing a folder. No .webm/.mp4: those are yt-dlp's half-done downloads
AUDIO_EXTS = {'.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.flac', '.wav', '.wma', '.alac'}
YT_LINK = re.compile(r'(?:youtube\.com/(?:watch\?(?:\S*&)?v=|shorts/|embed/)|youtu\.be/)([\w-]{11})')
TRACK_NO = re.compile(r'^\s*\d{1,4}\s*(?:[-._)]\s*|\s+)')
PICTURE_TAGS = ('apic', 'covr', 'metadata_block_picture', 'wm/picture')


def log(*parts):
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(map(str, parts)) + '\n')


def tool(name):
    """Prefer the bundled binary, fall back to PATH when running from source."""
    exe = BIN / f'{name}.exe'
    return str(exe) if exe.exists() else shutil.which(name)


def set_hidden(path, hidden=True):
    try:
        ctypes.windll.kernel32.SetFileAttributesW(str(path), 0x2 if hidden else 0x80)
    except (OSError, AttributeError):
        pass


def clean_error(err):
    msg = re.sub(r'\x1b\[[0-9;]*m', '', str(err))
    msg = re.sub(r'^(ERROR:\s*)?(\[[^\]]+\]\s*)?([\w-]+:\s*)?', '', msg.strip())
    low = msg.lower()
    if 'not a bot' in low or 'sign in to confirm' in low:
        return 'YouTube wants a signed-in account for this. Sign in from the account menu and try again.'
    if 'playlist does not exist' in low or 'unviewable' in low or 'private' in low and 'playlist' in low:
        return 'This playlist is private. Sign in with the account that owns it.'
    if 'unsupported url' in low or 'is not a valid url' in low:
        return "That doesn't look like a YouTube link."
    if 'video unavailable' in low:
        return 'This video is unavailable.'
    if 'no space left' in low or 'disk full' in low or 'errno 28' in low:
        return 'The drive is full. Free up space or pick another folder.'
    if 'getaddrinfo' in low or 'connection' in low and 'refused' not in low:
        return 'No connection to YouTube. Check your internet and try again.'
    return msg.split('\n')[0][:220] or 'Something went wrong.'


# ---- naming ---------------------------------------------------------------

def clean_channel(name):
    name = re.sub(r'\s+-\s+Topic$', '', name or '')
    name = re.sub(r'(VEVO|\s+Official)$', '', name, flags=re.I)
    return name.strip()


def primary_artist(name):
    """'A, B feat. C' -> 'A', so each artist gets one folder."""
    name = re.split(r'\s*,\s*|\s+(?:feat\.?|ft\.?|featuring|x|X|with)\s+', name or '')[0]
    return name.strip(' -')


def tidy_title(title):
    """'Song (Official Video) | Movie' -> 'Song'. Leaves real titles like 'Video Games' alone."""
    clean = re.sub(r'\s*#\w+', '', title)
    clean = re.sub(r'\s*[\(\[【]([^\)\]】]*)[\)\]】]',
                   lambda m: '' if JUNK.search(m.group(1)) else m.group(0), clean)
    clean = clean.split(' | ')[0].split(' || ')[0]
    parts = [p for p in re.split(r'\s+[-–—]\s+', clean) if not JUNK_PART.fullmatch(p)]
    clean = ' - '.join(parts)
    clean = re.sub(r'\s+(4K|8K|HD|HQ)$', '', clean, flags=re.I)
    clean = re.sub(r'\s{2,}', ' ', clean).strip(' -–—|')
    return clean or title.strip()


def split_artist_title(info):
    raw = info.get('title') or info.get('id') or ''
    channel = clean_channel(info.get('channel') or info.get('uploader') or '')
    artists = info.get('artists') or ([info['artist']] if info.get('artist') else [])
    if artists and info.get('track'):
        return primary_artist(clean_channel(artists[0])), tidy_title(info['track'])
    clean = tidy_title(raw)
    m = re.match(r'^(.{1,60}?)\s+[-–—]\s+(.+)$', clean)
    if m:
        left, right = m.group(1), m.group(2)
        # 'Song - Artist' is common too; the channel name tells them apart
        if channel and channel.lower() in right.lower() and channel.lower() not in left.lower():
            left, right = right, left
        return primary_artist(left), right
    return primary_artist(channel), clean


def car_safe(name, limit=72):
    """Plain ASCII names that every car stereo can show and FAT32 accepts."""
    name = ''.join(ch for ch in name if unicodedata.category(ch)[0] not in 'SC' or ch in '&')
    name = anyascii(name)
    name = re.sub(r"[^A-Za-z0-9 \-_.,'()&!]", '', name)
    name = re.sub(r'\s{2,}', ' ', name).strip(' .-')
    return name[:limit].rstrip(' .-') or 'Track'


def detect_language(info, fallback='English'):
    text = ' '.join([info.get('title') or '', info.get('track') or '', ' '.join(info.get('tags') or [])])
    for pattern, lang in SCRIPTS:
        if re.search(pattern, text):
            return lang
    for pattern, lang in LANG_WORDS:
        if re.search(pattern, text, re.I):
            return lang
    codes = [info.get('language')] + [
        f.get('language') for f in sorted(info.get('formats') or [], key=lambda f: -(f.get('language_preference') or -1))
        if f.get('acodec') not in (None, 'none')]
    for code in codes:
        if code and code.split('-')[0].lower() in LANG_CODES:
            return LANG_CODES[code.split('-')[0].lower()]
    desc = (info.get('description') or '')[:600]
    for pattern, lang in SCRIPTS:
        if re.search(pattern, desc):
            return lang
    return fallback


def safe_dir(name, fallback):
    name = sanitize_filename((name or '').strip(), restricted=False).strip(' .') or fallback
    return name[:80]


# ---- cross-referencing songs already in a folder -----------------------------

def name_key(text):
    """'Tum Hi Ho (feat. X)' and 'TUM HI HO' both -> 'tumhiho', so tags, file names and titles compare."""
    text = re.split(r'\s[\(\[]?(?:feat|ft|featuring)\.?\s', anyascii(text or ''), flags=re.I)[0]
    return re.sub(r'[^a-z0-9]', '', text.lower())


def song_key(title, artist=''):
    """(artist, title) keys the same way Sonora names files, whichever way round they were written."""
    artist, title = split_artist_title({'title': title, 'channel': artist})
    return name_key(artist), name_key(title)


def read_tags(path):
    """[video id, artist, title] from a song's tags. Sonora's own files carry the YouTube link in
    the comment, so they match exactly; anything else falls back to artist and title."""
    try:
        tags = getattr(mutagen.File(path), 'tags', None)
    except Exception:
        tags = None
    vid, artist, title = None, '', ''
    for key, value in (tags.items() if tags else []):
        k = str(key).lower()
        if k.startswith(PICTURE_TAGS):
            continue
        text = ', '.join(map(str, value)) if isinstance(value, list) else str(value)
        text = text.replace('\x00', ', ')
        if k in ('tit2', '©nam', 'title') and not title:
            title = text
        elif k in ('tpe1', '©art', 'artist', 'author') and not artist:
            artist = text
        elif not vid and ('comm' in k or 'comment' in k or 'purl' in k or '©cmt' in k):
            m = YT_LINK.search(text)
            vid = m.group(1) if m else None
    return [vid, artist[:200], title[:300]]


# ---- logging, settings, cookies -------------------------------------------

class Logger:
    """Swallows yt-dlp's console output and keeps errors in the log file."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        log('WARN', msg)

    def error(self, msg):
        log('ERROR', msg)


class Settings(dict):
    def __init__(self):
        super().__init__(DEFAULTS)
        try:
            self.update(json.loads(SETTINGS_FILE.read_text('utf-8')))
        except (OSError, ValueError):
            pass

    def save(self):
        SETTINGS_FILE.write_text(json.dumps(self, indent=2), 'utf-8')


def write_netscape(cookies, path):
    """Write pywebview SimpleCookie objects as a cookies.txt yt-dlp can read."""
    lines = ['# Netscape HTTP Cookie File', '# Written by Sonora', '']
    for jar in cookies:
        for name, m in jar.items():
            domain = m['domain'] or '.youtube.com'
            try:
                expires = int(parsedate_to_datetime(m['expires']).timestamp()) if m['expires'] else 0
            except (TypeError, ValueError, OverflowError):
                expires = 0
            prefix = '#HttpOnly_' if m['httponly'] else ''
            lines.append('\t'.join([
                prefix + domain, 'TRUE' if domain.startswith('.') else 'FALSE', m['path'] or '/',
                'TRUE' if m['secure'] else 'FALSE', str(max(expires, 0)), name, m.value]))
    Path(path).write_text('\n'.join(lines) + '\n', 'utf-8')


def cookie_names(path):
    names = set()
    try:
        for line in Path(path).read_text('utf-8', 'ignore').splitlines():
            if line.startswith('#HttpOnly_'):
                line = line[len('#HttpOnly_'):]
            parts = line.split('\t')
            if len(parts) >= 7 and not line.startswith('#') and 'youtube' in parts[0]:
                names.add(parts[5])
    except OSError:
        pass
    return names


# ---- drives and the saved-songs list ----------------------------------------

def list_drives():
    """Removable drives with media in them, e.g. USB sticks and SD cards."""
    k = ctypes.windll.kernel32
    k.SetErrorMode(0x1)  # no "insert a disk" popups for empty card readers
    mask, drives = k.GetLogicalDrives(), []
    for i in range(26):
        root = f'{chr(65 + i)}:\\'
        if not mask & (1 << i) or k.GetDriveTypeW(root) != 2:
            continue
        label, fs = ctypes.create_unicode_buffer(261), ctypes.create_unicode_buffer(261)
        if not k.GetVolumeInformationW(root, label, 261, None, None, None, fs, 261):
            continue
        try:
            total, _, free = shutil.disk_usage(root)
        except OSError:
            continue
        drives.append({'root': root, 'letter': root[:2], 'label': label.value or 'USB drive',
                       'fs': fs.value, 'free': free, 'total': total})
    return drives


class Library:
    """Which songs are already in a folder, kept in a hidden file there.

    Songs are known by the YouTube link in their tags or, for songs copied there some
    other way, by artist and title, so a USB stick filled by hand or on another PC is
    cross-referenced too. Unlike yt-dlp's archive this checks the file still exists,
    so songs deleted from a USB stick get downloaded again.

    The file also remembers which playlists were saved there, so plugging the stick
    back in can top those playlists up."""

    _open = {}
    _open_lock = threading.Lock()

    @classmethod
    def at(cls, base):
        """One shared copy per folder, so downloads and scans never overwrite each other's
        writes. Reloaded when the file changes under it, e.g. another stick on the same letter."""
        key = os.path.normcase(os.path.abspath(base))
        with cls._open_lock:
            lib = cls._open.get(key)
            if not lib or lib.stamp != lib._stamp():
                lib = cls._open[key] = cls(base)
            return lib

    def __init__(self, base):
        self.base = Path(base)
        self.path = self.base / LIBRARY_NAME
        self.lock = threading.RLock()
        self.scanned = False
        try:
            data = json.loads(self.path.read_text('utf-8'))
        except (OSError, ValueError):
            data = {}
        self.songs = data.get('songs', {})      # video id -> file Sonora saved it as
        self.files = data.get('files', {})      # every song file -> [size, mtime, video id, artist, title]
        self.sources = data.get('sources', {})  # playlist link -> {'title', 'last'}
        self.stamp = self._stamp()
        self._index()

    def _stamp(self):
        try:
            st = self.path.stat()
            return st.st_size, st.st_mtime_ns
        except OSError:
            return None

    def _index(self):
        ids, titles = dict(self.songs), {}
        for rel, (_, _, vid, artist, title) in self.files.items():
            if vid:
                ids.setdefault(vid, rel)
            if not title:  # untagged: go by the file name, minus car-mode track numbers
                title = TRACK_NO.sub('', Path(rel).stem)
            a, t = song_key(title, artist)
            if t:
                titles.setdefault(t, []).append((a, rel))
        self.ids, self.titles = ids, titles

    def _save(self):
        try:
            set_hidden(self.path, False)  # Windows refuses to overwrite hidden files
            self.path.write_text(json.dumps({'version': 2, 'songs': self.songs, 'files': self.files,
                                             'sources': self.sources}), 'utf-8')
            set_hidden(self.path)
            self.stamp = self._stamp()
        except OSError as e:
            log('library write failed', e)

    def scan(self, progress=None):
        """Read every song in the folder. Tags are read once; later scans only stat the files,
        so plugging a full stick back in takes seconds."""
        with self.lock:
            seen, read = {}, 0
            for root, dirs, names in os.walk(self.base):
                dirs[:] = [d for d in dirs if not d.startswith(('.', '$')) and d.lower() != 'system volume information']
                for name in names:
                    if os.path.splitext(name)[1].lower() not in AUDIO_EXTS:
                        continue
                    full = os.path.join(root, name)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    rel = os.path.relpath(full, self.base)
                    old = self.files.get(rel)
                    if old and old[0] == st.st_size and old[1] == int(st.st_mtime):
                        seen[rel] = old
                    else:
                        seen[rel] = [st.st_size, int(st.st_mtime), *read_tags(full)]
                        read += 1
                    if progress and len(seen) % 25 == 0:
                        progress(len(seen))
            changed = read or seen.keys() != self.files.keys()
            self.files = seen
            self._index()
            self.scanned = True
            if changed:
                self._save()
            return len(seen)

    def has(self, vid):
        rel = self.ids.get(vid)
        return bool(rel) and (self.base / rel).exists()

    def match(self, item):
        """Is this song already here? By video id first, then by artist and title."""
        if self.has(item['id']):
            return True
        a, t = song_key(item.get('title') or '', item.get('channel') or '')
        for artist, rel in self.titles.get(t, []) if t else []:
            # Uploaders like 'T-Series' aren't the artist, so a long, distinctive title is enough;
            # short ones like 'Intro' also need the artists to agree
            same = len(t) >= 10 or not artist or not a or artist in a or a in artist
            if same and (self.base / rel).exists():
                return True
        return False

    def add(self, vid, file):
        with self.lock:
            try:
                rel = os.path.relpath(file, self.base)
            except ValueError:
                return
            self.songs[vid] = self.ids[vid] = rel
            self._save()

    def remember(self, url, title):
        with self.lock:
            self.sources[url] = {'title': title, 'last': int(time.time())}
            self._save()

    def source_list(self):
        return sorted(({'url': u, **v} for u, v in self.sources.items()), key=lambda s: -s.get('last', 0))


class Shaper(PostProcessor):
    """Runs before the download to set the folder, file name and tags per song."""

    def __init__(self, fn):
        super().__init__(None)
        self._fn = fn

    def run(self, info):
        self._fn(info)
        return [], info


class Job:
    def __init__(self, items, settings, title, kind):
        s = settings
        self.items = items
        self.base = Path(s['folder'])
        self.fmt = 'mp3' if s['car'] else s['format']
        self.quality, self.skip_saved = s['quality'], s['skip_saved']
        self.car, self.numbers, self.level = s['car'], s['car_numbers'], s['car_level']
        self.tidy = s['tidy'] or s['car']
        self.sort = s['sort']
        self.total = len(items)
        self.library = Library.at(self.base)
        self.cancel = threading.Event()
        self.counts = {'done': 0, 'skipped': 0, 'failed': 0}
        self.lock = threading.Lock()
        self.convert = threading.Semaphore(CONVERTERS)

        # Folder: fixed for most sort modes, decided per song for artist and auto language
        self.dynamic, self.album = None, None
        sub = None
        if self.sort == 'playlist' and kind == 'playlist':
            sub = self.album = title
        elif self.sort in BUCKETS:
            bucket = s[self.sort]
            if self.sort == 'language' and bucket == 'auto':
                self.dynamic = 'language'
            else:
                sub = self.album = bucket or 'Unsorted'
        elif self.sort == 'artist':
            self.dynamic = 'artist'
            self.album = title if kind == 'playlist' else None
        self.target = self.base / safe_dir(sub, 'Unsorted') if sub else self.base


class Api:
    def __init__(self):
        self._settings = Settings()
        self._window = None
        self._login = None
        self._job = None
        self._events = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    # ---- plumbing --------------------------------------------------------

    def _emit(self, kind, **data):
        self._events.put({'type': kind, **data})

    def _pump(self):
        """Batch events into one JS call a few times a second so workers never wait on the UI."""
        while True:
            batch = [self._events.get()]
            time.sleep(0.25)
            while not self._events.empty():
                batch.append(self._events.get_nowait())
            if self._window:
                try:
                    self._window.run_js(f'window.sonora && window.sonora.receive({json.dumps(batch)})')
                except Exception as e:
                    log('emit failed', e)

    def _cookie_args(self):
        if self._settings.get('account') and COOKIE_FILE.exists():
            # Each yt-dlp instance writes its jar back on exit, so give it a private copy
            fd, tmp = tempfile.mkstemp(prefix='sonora-', suffix='.txt')
            os.close(fd)
            shutil.copyfile(COOKIE_FILE, tmp)
            return ['--cookies', tmp], tmp
        return [], None

    def _ydl_opts(self, args):
        common = ['--ignore-config', '--no-color', '--js-runtimes', 'deno:' + (tool('deno') or 'deno')]
        if ff := tool('ffmpeg'):
            common += ['--ffmpeg-location', str(Path(ff).parent)]
        opts = yt_dlp.parse_options(common + args).ydl_opts
        opts.update(logger=Logger(), quiet=True, noprogress=True)
        return opts

    def _account_state(self):
        acc = self._settings.get('account')
        if acc and not COOKIE_FILE.exists():
            acc = None
        return acc

    # ---- called from the UI ---------------------------------------------

    def init(self):
        s = self._settings
        return {
            **{k: s[k] for k in SETTING_KEYS | set(BUCKETS.values()) | {'folder', 'pc_folder', 'theme', 'themes'}},
            'account': self._account_state(), 'version': VERSION,
            'drives': self.drives(), 'low_end': LOW_END, 'workers': WORKERS,
            'missing': [n for n in ('ffmpeg', 'deno') if not tool(n)],
        }

    def set_setting(self, key, value):
        if key in SETTING_KEYS:
            self._settings[key] = value
            self._settings.save()
        return True

    def add_bucket(self, kind, name):
        key = BUCKETS.get(kind)
        name = safe_dir(name, '')
        if not key or not name:
            return {'error': 'Give the folder a name.'}
        items = self._settings[key]
        if name.lower() not in (x.lower() for x in items):
            items.append(name)
        self._settings[kind] = next(x for x in items if x.lower() == name.lower())
        self._settings.save()
        return {'list': items, 'selected': self._settings[kind]}

    def remove_bucket(self, kind, name):
        key = BUCKETS.get(kind)
        if key:
            self._settings[key] = [x for x in self._settings[key] if x != name]
            if self._settings[kind] == name:
                self._settings[kind] = 'auto' if kind == 'language' else (self._settings[key] or [''])[0]
            self._settings.save()
        return {'list': self._settings.get(key, []), 'selected': self._settings.get(kind)}

    def use_theme(self, theme_id, bg):
        self._settings['theme'] = str(theme_id)[:40]
        if HEX_COLOR.match(str(bg)):
            self._settings['theme_bg'] = bg
        self._settings.save()
        return True

    def save_theme(self, theme):
        name = ' '.join(str(theme.get('name') or '').split())[:32] or 'My theme'
        colors = {k: str(theme.get(k, '')).lower() for k in THEME_COLORS}
        if not all(HEX_COLOR.match(v) for v in colors.values()):
            return {'error': 'Every colour needs a hex code like #1a2b3c.'}
        themes = self._settings['themes']
        tid = theme.get('id')
        old = next((t for t in themes if t['id'] == tid), None) if tid else None
        if old:
            old.update(name=name, **colors)
        elif len(themes) >= MAX_THEMES:
            return {'error': f'You can keep up to {MAX_THEMES} themes. Delete one first.'}
        else:
            tid = f'custom-{int(time.time() * 1000):x}'
            themes.append({'id': tid, 'name': name, **colors})
        self._settings.update(theme=tid, theme_bg=colors['bg'])
        self._settings.save()
        return {'themes': themes, 'theme': tid}

    def delete_theme(self, theme_id):
        self._settings['themes'] = [t for t in self._settings['themes'] if t['id'] != theme_id]
        if self._settings['theme'] == theme_id:
            self._settings.update(theme=DEFAULTS['theme'], theme_bg=DEFAULTS['theme_bg'])
        self._settings.save()
        return {'themes': self._settings['themes'], 'theme': self._settings['theme']}

    def fetch(self, url):
        url = (url or '').strip()
        if url in LIKED:
            if not self._account_state():
                return {'error': 'Sign in first so Sonora can see your liked songs.', 'needs_login': True}
            url = LIKED[url]
        if not re.match(r'^(https?://)?([\w-]+\.)*(youtube\.com|youtu\.be)/', url, re.I):
            return {'error': 'Paste a YouTube or YouTube Music link.'}

        args = ['--flat-playlist', '--no-ignore-errors']
        if 'list=RD' in url:  # auto-generated mixes are endless; take just the song
            args.append('--no-playlist')
        cargs, tmp = self._cookie_args()
        try:
            with yt_dlp.YoutubeDL(self._ydl_opts(args + cargs)) as ydl:
                info = ydl.sanitize_info(ydl.extract_info(url, download=False))
                # Channel links resolve to their tabs; use the Videos tab
                entries = info.get('entries') or []
                if entries and all('/channel/' in (e.get('url') or '') or e.get('ie_key') == 'YoutubeTab'
                                   for e in entries):
                    tab = next((e for e in entries if (e.get('url') or '').endswith('/videos')), entries[0])
                    info = ydl.sanitize_info(ydl.extract_info(tab['url'], download=False))
        except Exception as e:
            log('fetch failed', url, e)
            return {'error': clean_error(e)}
        finally:
            if tmp:
                Path(tmp).unlink(missing_ok=True)
        return self._describe(info)

    def _describe(self, info):
        is_list = info.get('_type') == 'playlist'
        raw = info.get('entries') if is_list else [info]
        title = info.get('title') or 'Untitled'
        if info.get('id') == 'LL':
            title = 'Liked videos'
        elif info.get('id') == 'LM':
            title = 'Liked music'
        library = self._library()

        items, hidden = [], 0
        for e in raw or []:
            if not e or not e.get('id') or (e.get('title') or '').strip('[]').lower() in (
                    'private video', 'deleted video'):
                hidden += 1
                continue
            vid = e['id']
            item = {
                'id': vid,
                'title': e.get('track') or e.get('title') or vid,
                'channel': clean_channel(e.get('artist') or e.get('channel') or e.get('uploader') or ''),
                'duration': e.get('duration') or 0,
                # The small thumbnail decodes far faster in long lists
                'thumb': f'https://i.ytimg.com/vi/{vid}/default.jpg',
                'url': e.get('webpage_url') or e.get('url') or f'https://www.youtube.com/watch?v={vid}',
            }
            item['saved'] = library.match(item)
            items.append(item)
        return {
            'kind': 'playlist' if is_list else 'video',
            'title': title,
            'owner': clean_channel(info.get('channel') or info.get('uploader') or ''),
            'hidden': hidden,
            'items': items,
        }

    def _library(self, folder=None):
        """The folder's library, cross-referenced against what's really in it the first time."""
        library = Library.at(folder or self._settings['folder'])
        if not library.scanned:
            library.scan(lambda n: self._emit('scan', count=n))
        return library

    def saved_ids(self, items):
        """Re-check which songs are already saved, after the folder changes."""
        library = self._library()
        items = [i if isinstance(i, dict) else {'id': i} for i in items]
        return [i['id'] for i in items if library.match(i)]

    def scan(self, root=None):
        """Cross-reference a folder (by default the save folder) with the songs really in it,
        and say which playlists were saved there before so they can be topped up."""
        folder = root or self._settings['folder']
        if self._job and Path(folder) == self._job.base:
            return {'error': 'Wait for the download to finish first.'}
        library = Library.at(folder)
        try:
            count = library.scan(lambda n: self._emit('scan', count=n))
        except OSError as e:
            return {'error': f"Can't read {folder}: {e.strerror}"}
        return {'songs': count, 'known': bool(library.songs or library.sources),
                'sources': library.source_list()}

    def start(self, items, title, kind, url=None):
        if self._job and not self._job.cancel.is_set():
            return {'error': 'A download is already running.'}
        job = Job(items, self._settings, title, kind)
        try:
            job.target.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return {'error': f"Can't write to {job.target}: {e.strerror}. Is the drive plugged in?"}
        if url and kind == 'playlist':
            job.library.remember(url, title)
        self._job = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return {'ok': True, 'target': str(job.target)}

    def cancel(self):
        if self._job:
            self._job.cancel.set()
        return True

    def _run(self, job):
        with ThreadPoolExecutor(WORKERS) as pool:
            for n, item in enumerate(job.items, 1):
                pool.submit(self._download, job, item, n)
        self._emit('job_done', counts=job.counts, cancelled=job.cancel.is_set(), target=str(job.target))
        if self._job is job:
            self._job = None

    def _shape(self, job, n, info):
        """Pick the song's folder, file name and tags once its full details are known."""
        artist, title = split_artist_title(info)
        if job.tidy:
            info['track'], info['title'] = title, title
            if artist:
                info['artist'], info['artists'] = artist, [artist]
        if job.album and not info.get('album'):
            info['album'] = job.album
        if job.car and job.numbers and job.total > 1:
            info['track_number'] = n

        name = info.get('title') or info['id']
        if job.tidy and artist and artist.lower() not in title.lower():
            name = f'{artist} - {title}'
        if job.car:
            name = car_safe(name)
            if job.numbers and job.total > 1:
                name = f'{n:0{max(2, len(str(job.total)))}d} - {name}'
        info['sonora_name'] = name

        if job.dynamic == 'artist':
            folder = artist or clean_channel(info.get('channel') or '') or 'Unknown artist'
            info['sonora_dir'] = car_safe(folder, 48) if job.car else safe_dir(folder, 'Unknown artist')
        elif job.dynamic == 'language':
            info['sonora_dir'] = detect_language(info)

    def _download(self, job, item, n):
        vid = item['id']
        if job.cancel.is_set():
            return self._emit('item', id=vid, status='cancelled')
        if job.skip_saved and job.library.match(item):
            with job.lock:
                job.counts['skipped'] += 1
            return self._emit('item', id=vid, status='skipped')

        self._emit('item', id=vid, status='downloading', pct=0)
        state = {'last': 0, 'file': None, 'converting': False}

        def on_progress(d):
            if job.cancel.is_set():
                raise DownloadCancelled()
            if d['status'] == 'downloading':
                now = time.monotonic()
                if now - state['last'] < 0.5:
                    return
                state['last'] = now
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                done = d.get('downloaded_bytes') or 0
                self._emit('item', id=vid, status='downloading',
                           pct=round(done / total * 100) if total else 0, speed=d.get('speed') or 0)
            elif d['status'] == 'finished' and not state['converting']:
                self._emit('item', id=vid, status='converting', pct=100)
                job.convert.acquire()  # wait our turn for ffmpeg
                state['converting'] = True

        def on_post(d):
            if d['status'] == 'finished':
                state['file'] = d.get('info_dict', {}).get('filepath') or state['file']

        codec_fmt, codec = FORMATS.get(job.fmt, FORMATS['mp3'])
        folder = '%(sonora_dir)s' if job.dynamic else None
        template = str(job.target).replace('%', '%%') + os.sep + (folder + os.sep if folder else '')
        args = [
            '-f', codec_fmt, '-x', '--audio-format', codec,
            '--audio-quality', job.quality if codec == 'mp3' else '0',
            '--embed-metadata', '--no-embed-chapters', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
            '--ppa', COVER_CAR if job.car else COVER_NORMAL,
            '--replace-in-metadata', 'uploader,channel,artist', r'\s+-\s+Topic$', '',
            '--no-playlist', '--no-mtime', '--no-overwrites',
            '-o', template + '%(sonora_name)s.%(ext)s',
        ]
        if job.car:
            level = ' -af loudnorm=I=-14:TP=-1.5:LRA=11' if job.level else ''
            args += ['--ppa', f'ExtractAudio+FFmpeg_o:-ar 44100 -ac 2{level}',
                     '--ppa', 'Metadata+FFmpeg_o:-id3v2_version 3 -write_id3v1 1']
        cargs, tmp = self._cookie_args()
        try:
            opts = self._ydl_opts(args + cargs)
            opts.update(progress_hooks=[on_progress], postprocessor_hooks=[on_post])
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.add_post_processor(Shaper(lambda info: self._shape(job, n, info)), when='pre_process')
                code = ydl.download([item['url']])
            if job.cancel.is_set():
                return self._emit('item', id=vid, status='cancelled')
            if code or not state['file']:
                raise RuntimeError('yt-dlp could not download this one.')
            job.library.add(vid, state['file'])
            with job.lock:
                job.counts['done'] += 1
            size = Path(state['file']).stat().st_size if Path(state['file']).exists() else 0
            self._emit('item', id=vid, status='done', file=state['file'], size=size)
        except DownloadCancelled:
            self._emit('item', id=vid, status='cancelled')
        except Exception as e:
            if job.cancel.is_set():
                return self._emit('item', id=vid, status='cancelled')
            log('download failed', vid, traceback.format_exc())
            with job.lock:
                job.counts['failed'] += 1
            self._emit('item', id=vid, status='failed', error=clean_error(e))
        finally:
            if state['converting']:
                job.convert.release()
            if tmp:
                Path(tmp).unlink(missing_ok=True)

    # ---- folders and drives ----------------------------------------------

    def drives(self):
        try:
            return list_drives()
        except Exception as e:
            log('drive scan failed', e)
            return []

    def use_drive(self, root):
        """Save to a USB drive's root, or back to the PC folder when root is empty."""
        if root and not any(d['root'] == root for d in self.drives()):
            return {'error': 'That drive is no longer plugged in.'}
        self._settings['folder'] = root or self._settings['pc_folder']
        self._settings.save()
        return {'folder': self._settings['folder']}

    def choose_folder(self):
        start = self._settings['pc_folder'] if Path(self._settings['pc_folder']).exists() else str(Path.home())
        picked = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=start)
        if picked:
            self._settings['folder'] = picked[0]
            if not any(picked[0].upper().startswith(d['root']) for d in self.drives()):
                self._settings['pc_folder'] = picked[0]
            self._settings.save()
        return {'folder': self._settings['folder'], 'pc_folder': self._settings['pc_folder']}

    def open_folder(self, path=None):
        path = Path(path or self._settings['folder'])
        try:
            path.mkdir(parents=True, exist_ok=True)
            os.startfile(path)
        except OSError:
            return False
        return True

    def reveal(self, file):
        if file and Path(file).exists():
            subprocess.Popen(['explorer', '/select,', str(Path(file))])
        return True

    def eject(self, letter):
        if not re.fullmatch(r'[A-Z]:', letter or ''):
            return {'error': 'Unknown drive.'}
        if self._job and str(self._job.base).upper().startswith(letter):
            return {'error': 'Wait for the download to finish first.'}
        script = f"(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{letter}').InvokeVerb('Eject')"
        subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
        for _ in range(10):
            if not any(d['letter'] == letter for d in self.drives()):
                return {'ok': True}
            time.sleep(0.5)
        return {'error': f'{letter} is still in use. Close any windows showing it and try again.'}

    # ---- account ---------------------------------------------------------

    def _set_account(self, source):
        if not AUTH_COOKIES & cookie_names(COOKIE_FILE):
            COOKIE_FILE.unlink(missing_ok=True)
            return None
        self._settings['account'] = {'source': source, 'since': int(time.time())}
        self._settings.save()
        return self._settings['account']

    def sign_in(self):
        if self._login:
            self._login.restore()
            return True
        win = webview.create_window('Sign in to YouTube', LOGIN_URL, width=500, height=720,
                                    background_color='#FFFFFF')
        self._login = win

        def on_loaded():
            url = win.get_current_url() or ''
            if not re.match(r'https://(www|music)\.youtube\.com', url):
                return
            cookies = win.get_cookies()
            if not any(AUTH_COOKIES & set(c.keys()) for c in cookies):
                return
            write_netscape(cookies, COOKIE_FILE)
            acc = self._set_account('signin')
            if acc:
                self._emit('account', account=acc)
                win.destroy()

        def on_closed():
            self._login = None
            self._emit('login_closed')

        win.events.loaded += on_loaded
        win.events.closed += on_closed
        return True

    def import_cookies(self):
        picked = self._window.create_file_dialog(
            webview.FileDialog.OPEN, file_types=('Cookie files (*.txt)', 'All files (*.*)'))
        if not picked:
            return {'cancelled': True}
        shutil.copyfile(picked[0], COOKIE_FILE)
        acc = self._set_account('file')
        if not acc:
            return {'error': "That file has no signed-in YouTube cookies. Export it while you're signed in."}
        return {'account': acc}

    def use_browser(self, browser):
        try:
            jar = yt_dlp.cookies.extract_cookies_from_browser(browser, logger=Logger())
            jar.filename = str(COOKIE_FILE)
            jar.save()
        except Exception as e:
            log('browser cookies failed', browser, e)
            msg = str(e)
            if 'DPAPI' in msg or 'App-Bound' in msg or '10927' in msg:
                return {'error': f'{browser.title()} encrypts its cookies so other apps can\'t read them. '
                                 'Use "Sign in" instead.'}
            if 'could not find' in msg:
                return {'error': f"Couldn't find a {browser.title()} profile on this PC."}
            if 'Permission' in msg or 'locked' in msg.lower():
                return {'error': f'Close {browser.title()} completely, then try again.'}
            return {'error': clean_error(e)}
        acc = self._set_account(browser)
        if not acc:
            return {'error': f"You're not signed in to YouTube in {browser.title()}."}
        return {'account': acc}

    def sign_out(self):
        COOKIE_FILE.unlink(missing_ok=True)
        self._settings['account'] = None
        self._settings.save()
        try:
            self._window.clear_cookies()
        except Exception as e:
            log('clear cookies failed', e)
        return True

    # ---- window ----------------------------------------------------------

    def minimize(self):
        self._window.minimize()

    def toggle_maximize(self):
        w = self._window
        if getattr(self, '_maxed', False):
            w.restore()
        else:
            w.maximize()
        self._maxed = not getattr(self, '_maxed', False)
        return self._maxed

    def close(self):
        if self._job:
            self._job.cancel.set()
        self._window.destroy()


def lower_priority():
    """Run below normal priority; ffmpeg and deno inherit it, the WebView2 UI doesn't."""
    try:
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    except (OSError, AttributeError):
        pass


def selftest(url, folder, *flags):
    """Download one link without the window, to check the bundled tools:
    Sonora.exe --selftest URL DIR [car] [artist|language]"""
    api = Api()
    api._settings.update(folder=folder, skip_saved=False, car='car' in flags,
                         sort=next((f for f in flags if f in ('artist', 'language', 'none')), 'none'),
                         language='auto')
    api._settings.save = lambda: None
    api._emit = lambda kind, **d: log('selftest', kind, d)
    info = api.fetch(url)
    if info.get('error'):
        log('selftest fetch error', info['error'])
        return 1
    api.start(info['items'][:1], info['title'], info['kind'])
    while api._job:
        time.sleep(0.3)
    return 0


def main():
    lower_priority()
    if len(sys.argv) >= 4 and sys.argv[1] == '--selftest':
        sys.exit(selftest(*sys.argv[2:]))
    api = Api()
    window = webview.create_window(
        APP_NAME, str(UI / 'index.html'), js_api=api,
        width=1100, height=740, min_size=(900, 640),
        frameless=True, easy_drag=False, text_select=False,
        background_color=bg if HEX_COLOR.match(bg := str(api._settings.get('theme_bg'))) else '#000000',
    )
    api._window = window
    WEBDATA.mkdir(parents=True, exist_ok=True)
    # Drop the WebView's file cache so an updated UI never runs stale CSS/JS; sign-in cookies live elsewhere
    for cache in ('Cache', 'Code Cache'):
        shutil.rmtree(WEBDATA / 'EBWebView' / 'Default' / cache, ignore_errors=True)
    webview.start(gui='edgechromium', private_mode=False, storage_path=str(WEBDATA),
                  debug=not FROZEN and '--debug' in sys.argv)


if __name__ == '__main__':
    main()
