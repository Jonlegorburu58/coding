"""Regression checks use an isolated database and synthetic records only."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from app import Store, call_tool, parse_date, parse_size, ROOT

class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.database=Path(self.temp.name)/'test.sqlite3'
        self.store=Store(self.database)
        rows=[[str(900000+i),str(1+i%5),'28/7/2022' if i==0 else '17/9/2021' if i==1 else '22/10/2019','58.3 KB','TEST_USER','pdf' if i%3==0 else 'docx'] for i in range(120)]
        columns=['document_number','version','edit_date','file_size','last_user','extension']
        self.capture={'captured_at':'2026-10-13T13:00:00+00:00','pages':[{'source_url':'https://dms.byrnewallace.com/work/web/r/libraries/TEST/folders/TEST!1','page':page,'displayed_total':123,'rendered_items':rendered,'columns':columns,'rows':rows[start:end]} for page,start,end,rendered in [(1,0,49,50),(2,49,97,50),(3,97,120,23)]]}
        self.result=self.store.ingest(self.capture)
    def tearDown(self): self.temp.cleanup()
    def test_pilot_reconciles(self):
        self.assertEqual((self.result['documents'],self.result['captured_items'],self.result['excluded_email_or_other_items']),(120,123,3))
        self.assertTrue(self.result['complete_folder_listing'])
        report=self.store.report(as_of='2026-10-13')
        self.assertEqual(sum(report['file_types'].values()),120)
        self.assertEqual(sum(report['last_editors'].values()),120)
        self.assertEqual(sum(report['edited_years'].values()),120)
    def test_import_is_idempotent(self):
        self.store.ingest(self.capture)
        self.assertEqual(len(self.store.captures()),1)
        self.assertEqual(len(self.store.records()[1]),120)
    def test_partial_capture_is_labelled(self):
        c=copy.deepcopy(self.capture);c['pages']=c['pages'][:1]
        self.assertFalse(self.store.ingest(c)['complete_folder_listing'])
    def test_duplicate_pages_rejected(self):
        c=copy.deepcopy(self.capture);c['pages'].append(c['pages'][0])
        with self.assertRaises(ValueError):self.store.ingest(c)
    def test_duplicate_documents_rejected(self):
        c=copy.deepcopy(self.capture);c['pages'][1]['rows'][0]=c['pages'][0]['rows'][0]
        with self.assertRaises(ValueError):self.store.ingest(c)
    def test_foreign_source_rejected(self):
        c=copy.deepcopy(self.capture);c['pages'][0]['source_url']='https://example.com/work/web/r/libraries/LIVE/folders/LIVE!1'
        with self.assertRaises(ValueError):self.store.ingest(c)
    def test_inconsistent_total_rejected(self):
        c=copy.deepcopy(self.capture);c['pages'][1]['displayed_total']=124
        with self.assertRaises(ValueError):self.store.ingest(c)
    def test_questions_are_grounded(self):
        for q in ['How many documents?','Show document types','Who last edited the documents?','Which are the largest documents?']:
            result=self.store.ask(q)
            self.assertEqual(result['status'],'answered')
            self.assertFalse(result['live_query_performed'])
            self.assertIn('source',result)
        self.assertEqual(self.store.ask('Summarize the contracts')['status'],'needs_document_retrieval')
        self.assertEqual(self.store.ask('Find Project Orion in all matters')['status'],'needs_live_search')
    def test_negated_since_question(self):
        result=self.store.ask("Which documents haven't been edited since 2020?")
        self.assertTrue(result['data'])
        self.assertTrue(all(r['edit_date']<'2020-01-01' for r in result['data']))
        expected=[r for r in self.store.records()[1] if r['edit_date']<'2020-01-01']
        self.assertEqual(result['data'],expected)
    def test_year_and_extension_filter(self):
        result=self.store.ask('How many PDF documents were edited before 2020?')
        self.assertTrue(all(r['edit_date']<'2020-01-01' and r['extension']=='pdf' for r in result['data']))
    def test_tool_validation(self):
        for name,args in [('list_documents',{'limit':201}),('import_capture',{'filename':'../escape.json'}),('capture_status',{'sql':'delete'}),('missing',{})]:
            with self.assertRaises(ValueError):call_tool(self.store,name,args)
    def test_local_mcp_handshake_and_tools(self):
        requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}},
            {'jsonrpc':'2.0','method':'notifications/initialized'},
            {'jsonrpc':'2.0','id':2,'method':'tools/list'},
            {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'analytics_report','arguments':{}}},
            {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'ask_metadata','arguments':{'question':'Show file types'}}},
            {'jsonrpc':'2.0','id':5,'method':'tools/call','params':{'name':'import_capture','arguments':{'filename':'../outside.json'}}}]
        process=subprocess.run([sys.executable,str(ROOT/'app.py'),'mcp','--database',str(self.database)],input='\n'.join(map(json.dumps,requests))+'\n',text=True,capture_output=True,timeout=15)
        self.assertEqual(process.returncode,0,process.stderr)
        responses=[json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([r['id'] for r in responses],[1,2,3,4,5])
        self.assertEqual(len(responses[1]['result']['tools']),5)
        self.assertEqual(json.loads(responses[2]['result']['content'][0]['text'])['document_count'],120)
        self.assertTrue(responses[-1]['result']['isError'])
    def test_date_and_size_parsing(self):
        self.assertEqual(parse_date('28/7/2022'),'2022-07-28')
        self.assertEqual(parse_size('1.5 MB'),1572864)
        with self.assertRaises(ValueError):parse_date('13/40/2025')

if __name__=='__main__':unittest.main(verbosity=2)
