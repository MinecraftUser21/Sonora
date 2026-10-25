# Build with:  .venv\Scripts\pyinstaller --noconfirm Sonora.spec
import re

a = Analysis(
    ['app.py'],
    datas=[('ui', 'ui'), ('vendor/bin', 'bin')],
    excludes=['tkinter'],
)

# PyInstaller also copies ffmpeg's DLLs next to Python; ffmpeg.exe only loads the ones in bin/
ffmpeg_dll = re.compile(r'^(av\w+|sw\w+|postproc)-\d+\.dll$', re.I)
a.binaries = [b for b in a.binaries if not ffmpeg_dll.match(b[0])]

pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='Sonora',
    icon='icon.ico',
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name='Sonora', upx=False)
