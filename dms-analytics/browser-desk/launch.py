"""Start the local app in a hidden child process and open its interface."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import webbrowser

root=Path(__file__).resolve().parent
url='http://127.0.0.1:8768'
def running():
    try:
        with urllib.request.urlopen(url+'/api/status',timeout=1) as response:
            return json.load(response).get('application')=='bws-browser-analytics'
    except Exception:
        return False
if not running():
    (root/'data').mkdir(exist_ok=True)
    with (root/'data'/'server.log').open('a',encoding='utf-8') as log:
        process=subprocess.Popen([sys.executable,str(root/'app.py'),'web'],cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    for _ in range(30):
        if running(): break
        if process.poll() is not None: raise SystemExit('The local server could not start. Check data/server.log; port 8768 may already be used.')
        time.sleep(.2)
    else: raise SystemExit('The local server did not become ready. Check data/server.log.')
if '--no-browser' not in sys.argv:
    edge=Path(os.environ.get('PROGRAMFILES(X86)',r'C:\Program Files (x86)'))/'Microsoft'/'Edge'/'Application'/'msedge.exe'
    if '--app' in sys.argv and edge.is_file():
        subprocess.Popen([str(edge),'--app='+url],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    else:
        webbrowser.open(url)
print('BWS DMS Desk is running at '+url)
