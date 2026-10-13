"""Local, dependency-free metadata analytics and MCP. No DMS credentials or API calls."""
import argparse
import collections
from contextlib import contextmanager
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
COLUMNS = ['document_number','version','edit_date','file_size','last_user','extension']
PROTOCOLS = ['2024-11-05','2025-03-26','2025-06-18']

def parse_date(value):
    if not value:
        return None
    for fmt in ('%d/%m/%Y','%Y-%m-%d'):
        try:
            return dt.datetime.strptime(value.strip(),fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError('Unrecognised edit date')

def parse_size(value):
    if not value:
        return None
    match=re.fullmatch(r'([\d.]+)\s*(B|KB|MB|GB)',value.strip(),re.I)
    if not match:
        raise ValueError('Unrecognised file size')
    return round(float(match[1])*{'B':1,'KB':1024,'MB':1024**2,'GB':1024**3}[match[2].upper()])

class Store:
    def __init__(self,path=ROOT/'data'/'analytics.sqlite3'):
        self.path=Path(path)
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY, source TEXT, captured_at TEXT, metadata TEXT);
                CREATE TABLE IF NOT EXISTS documents(capture_id TEXT, document_number TEXT, version INTEGER, edit_date TEXT, file_size_bytes INTEGER, last_user TEXT, extension TEXT, page INTEGER, PRIMARY KEY(capture_id,document_number));''')

    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.path,timeout=10)
        db.row_factory=sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self,capture):
        if not isinstance(capture,dict):
            raise ValueError('Capture must be a JSON object')
        pages=capture.get('pages',[])
        if not isinstance(pages,list) or not pages:
            raise ValueError('Capture must include at least one page')
        captured=dt.datetime.fromisoformat(capture['captured_at'].replace('Z','+00:00'))
        if captured.tzinfo is None:
            raise ValueError('Capture timestamp must include timezone')
        sources=[]; rows=[]; page_numbers=[]; rendered=0; totals=[]
        for page in pages:
            if not isinstance(page,dict) or not isinstance(page.get('rows'),list):
                raise ValueError('Each page must contain metadata rows')
            u=urlsplit(page['source_url'])
            if u.scheme!='https' or u.netloc!='dms.byrnewallace.com' or not re.fullmatch(r'/work/web/r/libraries/[^/]+/folders/[^/]+',u.path):
                raise ValueError('Only observed iManage folder URLs are accepted')
            source=u._replace(query='',fragment='').geturl()
            sources.append(source)
            if page.get('columns')!=COLUMNS:
                raise ValueError('Capture columns do not match the supported metadata view')
            number=page['page']
            if type(number) is not int or number<1 or number in page_numbers:
                raise ValueError('Invalid or duplicate page number')
            page_numbers.append(number)
            count=page['rendered_items']; total=page['displayed_total']
            if type(count) is not int or type(total) is not int or count<0 or total<0 or count<len(page['rows']):
                raise ValueError('Invalid item counts')
            rendered+=count; totals.append(total)
            for row in page['rows']:
                if not isinstance(row,list) or len(row)!=6 or not all(isinstance(v,str) for v in row):
                    raise ValueError('Invalid metadata row')
                doc,version,date,size,user,ext=row
                if not re.fullmatch(r'\d+',doc) or not version.isdigit() or int(version)<1:
                    raise ValueError('Document number and version must be positive numbers')
                if not re.fullmatch(r'[a-z0-9]+',ext) or len(user)>100:
                    raise ValueError('Invalid metadata value')
                rows.append((doc,int(version),parse_date(date),parse_size(size),user,ext,number))
        if len(set(sources))!=1 or len(set(totals))!=1:
            raise ValueError('Pages must come from the same folder and item count')
        if len({r[0] for r in rows})!=len(rows):
            raise ValueError('Duplicate document numbers; refresh and recollect the folder')
        if rendered>totals[0]:
            raise ValueError('Captured count exceeds the displayed total')
        complete=sorted(page_numbers)==list(range(1,max(page_numbers)+1)) and rendered==totals[0]
        metadata={'pages':sorted(page_numbers),'displayed_items':totals[0],'captured_items':rendered,'documents':len(rows),'excluded_email_or_other_items':rendered-len(rows),'complete_folder_listing':complete,'scope':'one folder; metadata only; excludes email content and document contents','fields_not_collected':['document title','document class','author','document contents','version history']}
        digest=hashlib.sha256(json.dumps(capture,sort_keys=True).encode()).hexdigest()[:24]
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO captures VALUES(?,?,?,?)',(digest,sources[0],captured.isoformat(),json.dumps(metadata)))
            db.executemany('INSERT OR IGNORE INTO documents VALUES(?,?,?,?,?,?,?,?)',[(digest,*r) for r in rows])
        return {'capture_id':digest,**metadata}

    def latest(self,capture_id=None):
        with self.connect() as db:
            row=db.execute('SELECT * FROM captures WHERE id=?',(capture_id,)).fetchone() if capture_id else db.execute('SELECT * FROM captures ORDER BY captured_at DESC, rowid DESC LIMIT 1').fetchone()
        if not row:
            raise ValueError('No capture found; collect and import a folder first')
        return dict(row)

    def captures(self):
        with self.connect() as db:
            return [{'capture_id':r['id'],'source':r['source'],'captured_at':r['captured_at'],**json.loads(r['metadata'])} for r in db.execute('SELECT * FROM captures ORDER BY captured_at DESC')]

    def records(self,capture_id=None):
        capture=self.latest(capture_id)
        with self.connect() as db:
            records=[dict(r) for r in db.execute('SELECT document_number,version,edit_date,file_size_bytes,last_user,extension,page FROM documents WHERE capture_id=? ORDER BY edit_date DESC,document_number',(capture['id'],))]
        return capture,records

    def report(self,capture_id=None,as_of=None):
        capture,records=self.records(capture_id)
        today=dt.date.fromisoformat(as_of) if as_of else dt.date.today()
        dates=[dt.date.fromisoformat(r['edit_date']) for r in records if r['edit_date']]
        return {'capture_id':capture['id'],'source':capture['source'],'captured_at':capture['captured_at'],'as_of':today.isoformat(),'coverage':json.loads(capture['metadata']),'document_count':len(records),'file_types':dict(collections.Counter(r['extension'] for r in records)),'last_editors':dict(collections.Counter(r['last_user'] or 'unknown' for r in records)),'edited_years':dict(sorted(collections.Counter(str(d.year) for d in dates).items())),'oldest_edit_date':min(dates).isoformat() if dates else None,'newest_edit_date':max(dates).isoformat() if dates else None,'not_edited_for_5_years':sum((today-d).days>=1826 for d in dates),'documents_with_version_above_one':sum(r['version']>1 for r in records),'maximum_displayed_version':max((r['version'] for r in records),default=0),'estimated_size_mib':round(sum(r['file_size_bytes'] or 0 for r in records)/1024**2,2),'unknown_edit_dates':len(records)-len(dates),'notes':['File sizes are estimates converted from rounded UI values.','Last user is the displayed last editor, not necessarily the author.','A displayed version number is not a count of retained historical versions.']}

    def ask(self,question,capture_id=None):
        if not isinstance(question,str) or not question.strip() or len(question)>4000:
            raise ValueError('Enter a question of at most 4,000 characters')
        report=self.report(capture_id); capture,records=self.records(capture_id)
        q=question.lower(); data=None; answer=''; status='answered'
        year=re.search(r'\b(19\d{2}|20\d{2})\b',q)
        if re.search(r'\b(contents?|clauses?|contracts?|summari[sz]e the|legal advice|authors?|classification|class|privilege)\b',q):
            status='needs_document_retrieval'; answer='This saved capture contains document metadata, not document contents, authors or classifications. A fresh DMS search and authorised retrieval are needed to answer that question.'
        elif year and any(w in q for w in ('since','after','before','in ')):
            y=int(year[1]); negative=bool(re.search(r"\b(not|never|haven['’]?t|hasn['’]?t)\b",q))
            if negative and 'since' in q or 'before' in q:
                compare=lambda r:int(r['edit_date'][:4])<y; criterion=f'before 1 January {y}'
            elif 'after' in q:
                compare=lambda r:int(r['edit_date'][:4])>y; criterion=f'after 31 December {y}'
            elif 'since' in q:
                compare=lambda r:int(r['edit_date'][:4])>=y; criterion=f'on or after 1 January {y}'
            else:
                compare=lambda r:int(r['edit_date'][:4])==y; criterion=f'in {y}'
            data=[r for r in records if r['edit_date'] and compare(r)]
            ext=re.search(r'\b(pdf|docx|xlsx|doc|xls|pptx|ppt)\b',q)
            if ext: data=[r for r in data if r['extension']==ext[1]]
            answer=f"{len(data)} {' '+ext[1].upper() if ext else ''} documents have a last edit date {criterion}.".replace('  ',' ')
        elif any(w in q for w in ('coverage','complete','scope','captured','how fresh')):
            data=report['coverage']; answer=f"Collected {data['captured_items']} of {data['displayed_items']} folder items across {len(data['pages'])} pages: {data['documents']} documents and {data['excluded_email_or_other_items']} excluded email/other entries. Captured {report['captured_at']}."
        elif any(w in q for w in ('largest','biggest')):
            data=sorted(records,key=lambda r:r['file_size_bytes'] or 0,reverse=True)[:10]; answer='The largest documents in this capture are listed below by document number.'
        elif any(w in q for w in ('oldest','newest','latest','most recent')):
            newest=any(w in q for w in ('newest','latest','recent')); data=sorted((r for r in records if r['edit_date']),key=lambda r:r['edit_date'],reverse=newest)[:10]; answer='These are the '+('most recently' if newest else 'least recently')+' edited documents in this capture.'
        elif any(w in q for w in ('version','revision')):
            data=[r for r in records if r['version']>1]; answer=f"{len(data)} documents display a version above 1; the highest displayed version is {report['maximum_displayed_version']}. This does not establish how many historical versions are retained."
        elif any(w in q for w in ('who','editor','user','modified by','edited by')):
            data=report['last_editors']; answer='Counts grouped by the last user displayed in iManage:'
        elif any(w in q for w in ('year','age','stale','old','inactive','since','before','after')):
            data=report['edited_years']; answer=f"Edit dates range from {report['oldest_edit_date']} to {report['newest_edit_date']}. {report['not_edited_for_5_years']} documents have not been edited for at least five years as of {report['as_of']}."
        elif any(w in q for w in ('size','storage','space')):
            data={'estimated_size_mib':report['estimated_size_mib']}; answer=f"The displayed file sizes total approximately {report['estimated_size_mib']} MiB. Rounded UI sizes make this an estimate."
        elif re.search(r'\b(pdf|docx|xlsx|doc|xls|pptx|ppt)\b',q):
            ext=re.search(r'\b(pdf|docx|xlsx|doc|xls|pptx|ppt)\b',q)[1]; data=[r for r in records if r['extension']==ext]; answer=f'{len(data)} {ext.upper()} documents are in this capture.'
        elif any(w in q for w in ('type','format','extension')):
            data=report['file_types']; answer='Document counts by file type:'
        elif any(w in q for w in ('how many','count','overview','summary')):
            data=report; answer=f"There are {report['document_count']} documents in the saved folder capture. The folder lists {report['coverage']['displayed_items']} total items, including excluded email entries."
        else:
            status='needs_live_search'; answer='That question needs a fresh DMS search or information outside this saved metadata capture. You can ask about counts, types, last editors, sizes, edit dates, versions or collection coverage here.'
        return {'status':status,'answer':answer,'data':data,'source':report['source'],'captured_at':report['captured_at'],'coverage':report['coverage'],'live_query_performed':False}

def import_file(store,filename):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+\.json',filename):
        raise ValueError('Use a JSON filename from the inbox, not a path')
    path=(ROOT/'inbox'/filename).resolve()
    if path.parent!=(ROOT/'inbox').resolve() or path.stat().st_size>20_000_000:
        raise ValueError('Invalid capture file')
    return store.ingest(json.loads(path.read_text(encoding='utf-8')))

TOOLS=[
    ('capture_status','List saved captures and their exact coverage.',{}),
    ('analytics_report','Calculate grounded analytics from a saved metadata capture.',{'capture_id':{'type':'string'},'as_of':{'type':'string'}}),
    ('ask_metadata','Answer supported natural-language metadata questions. Explicitly flags questions needing live search or document content.',{'question':{'type':'string'},'capture_id':{'type':'string'}}),
    ('list_documents','List document metadata from a saved capture.',{'capture_id':{'type':'string'},'extension':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':200}}),
    ('import_capture','Import a browser-collected JSON file from the local inbox. Only changes the local database.',{'filename':{'type':'string'}})
]

def call_tool(store,name,args):
    if not isinstance(args,dict): raise ValueError('Tool arguments must be an object')
    definition=next((t for t in TOOLS if t[0]==name),None)
    if not definition: raise ValueError('Unknown tool')
    if set(args)-set(definition[2]): raise ValueError('Unsupported tool argument')
    if name=='capture_status': return {'captures':store.captures(),'mode':'saved_metadata','live_browser_control':False}
    if name=='analytics_report': return store.report(args.get('capture_id'),args.get('as_of'))
    if name=='ask_metadata': return store.ask(args['question'],args.get('capture_id'))
    if name=='import_capture': return import_file(store,args['filename'])
    if name=='list_documents':
        limit=args.get('limit',50)
        if type(limit) is not int or not 1<=limit<=200: raise ValueError('Limit must be 1–200')
        capture,rows=store.records(args.get('capture_id'))
        if args.get('extension'): rows=[r for r in rows if r['extension']==args['extension'].lower()]
        return {'records':rows[:limit],'matching_records':len(rows),'captured_at':capture['captured_at'],'source':capture['source']}
    raise ValueError('Unknown tool')

def serve_mcp(store):
    sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8')
    initialized=False
    for line in sys.stdin:
        req=None
        try:
            req=json.loads(line)
            if not isinstance(req,dict) or req.get('jsonrpc')!='2.0': raise ValueError('Invalid JSON-RPC request')
            if 'id' not in req: continue
            method=req.get('method'); params=req.get('params') or {}
            if method=='initialize':
                requested=params.get('protocolVersion'); version=requested if requested in PROTOCOLS else PROTOCOLS[-1]
                result={'protocolVersion':version,'capabilities':{'tools':{'listChanged':False}},'serverInfo':{'name':'bws-browser-analytics','version':'1.0.0'},'instructions':'Saved metadata only. Always report capture time and scope. Never claim document-content access or a current live connection.'}; initialized=True
            elif method=='ping': result={}
            elif not initialized: raise ValueError('Initialize first')
            elif method=='tools/list':
                result={'tools':[{'name':n,'description':d,'inputSchema':{'type':'object','properties':p,'required':['question'] if n=='ask_metadata' else ['filename'] if n=='import_capture' else [],'additionalProperties':False},'annotations':{'readOnlyHint':n!='import_capture','destructiveHint':False,'openWorldHint':False}} for n,d,p in TOOLS]}
            elif method=='tools/call':
                try:
                    data=call_tool(store,params['name'],params.get('arguments') or {})
                    result={'content':[{'type':'text','text':json.dumps(data)}],'isError':False}
                except (ValueError,KeyError,TypeError,OSError) as exc:
                    result={'content':[{'type':'text','text':str(exc)}],'isError':True}
            else:
                print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True); continue
            print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
        except (ValueError,TypeError,KeyError) as exc:
            print(json.dumps({'jsonrpc':'2.0','id':req.get('id') if isinstance(req,dict) else None,'error':{'code':-32600 if req else -32700,'message':str(exc)}}),flush=True)

def serve_web(store,port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def send(self,code,data,kind='application/json'):
            body=json.dumps(data).encode() if kind=='application/json' else data
            self.send_response(code); self.send_header('Content-Type',kind); self.send_header('Content-Length',str(len(body))); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"); self.end_headers(); self.wfile.write(body)
        def allowed(self): return self.headers.get('Host') in (f'127.0.0.1:{port}',f'localhost:{port}')
        def do_GET(self):
            if not self.allowed(): return self.send(403,{'error':'Localhost access only'})
            path=urlsplit(self.path).path
            try:
                if path=='/api/status': return self.send(200,{'application':'bws-browser-analytics','captures':store.captures(),'mode':'saved_metadata'})
                if path=='/api/report': return self.send(200,store.report(parse_qs(urlsplit(self.path).query).get('capture_id',[None])[0]))
                if path=='/api/research-status': return self.send(200,{'available':(ROOT/'data'/'research.html').is_file()})
                if path=='/research': return self.send(200,(ROOT/'data'/'research.html').read_bytes(),'text/html; charset=utf-8')
                files={'/':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8'),'/collector.js':('collector.js','text/javascript; charset=utf-8')}
                if path in files:
                    filename,kind=files[path]; return self.send(200,(ROOT/filename).read_bytes(),kind)
                return self.send(404,{'error':'Not found'})
            except (ValueError,OSError) as exc: return self.send(400,{'error':str(exc)})
        def do_POST(self):
            origin=self.headers.get('Origin')
            if not self.allowed() or self.headers.get('X-BWS-Request')!='1' or origin not in (None,f'http://127.0.0.1:{port}',f'http://localhost:{port}'):
                return self.send(403,{'error':'Same-origin local requests only'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=20_000_000: raise ValueError('Invalid request size')
                payload=json.loads(self.rfile.read(length))
                if not isinstance(payload,dict): raise ValueError('Request must be a JSON object')
                path=urlsplit(self.path).path
                if path=='/api/ask': return self.send(200,store.ask(payload['question'],payload.get('capture_id')))
                if path=='/api/import': return self.send(200,store.ingest(payload))
                return self.send(404,{'error':'Not found'})
            except (ValueError,KeyError,TypeError,OSError) as exc: return self.send(400,{'error':str(exc)})
    print(f'Local interface: http://127.0.0.1:{port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('mode',choices=['web','mcp','import','report']); parser.add_argument('--port',type=int,default=8768); parser.add_argument('--file',default='pilot.json'); parser.add_argument('--database',type=Path,default=ROOT/'data'/'analytics.sqlite3'); args=parser.parse_args(); store=Store(args.database)
    if args.mode=='web': serve_web(store,args.port)
    elif args.mode=='mcp': serve_mcp(store)
    elif args.mode=='import': print(json.dumps(import_file(store,args.file),indent=2))
    else: print(json.dumps(store.report(),indent=2))

if __name__=='__main__': main()
