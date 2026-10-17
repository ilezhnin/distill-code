"""Invented local fixtures for the bounded browser broker; no browser or WSL."""
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import sys

sys.dont_write_bytecode = True

if os.name == 'nt':
    # pwd is used only at Linux launch; unit fixtures do not launch a runtime.
    sys.modules.setdefault('pwd', types.ModuleType('pwd'))
path = Path(__file__).resolve().parents[1]/'src-tauri/resources/benchmark-sandbox/bench-browser'
loader = importlib.machinery.SourceFileLoader('browser_broker',str(path))
spec = importlib.util.spec_from_loader(loader.name,loader)
broker = importlib.util.module_from_spec(spec)
loader.exec_module(broker)

class BrokerBounds(unittest.TestCase):
    def request(self, **values):
        return json.dumps({'kind':'render','output':'<p>Fixture</p>','spec':{},**values}).encode()

    def test_paths_are_owned_by_broker_and_expected_data_is_not_rewritten(self):
        spec={'argsCases':[{'args':[1],'expected':2}]}
        value=broker.validate_request(self.request(kind='javascript',spec=spec,
            screenshotPath='/etc/shadow',progressPath='/home/candidate/accounts/example'))
        self.assertIsNone(value['screenshotPath'])
        self.assertEqual(value['progressPath'],'/workspace/candidate-started')
        self.assertEqual(value['spec'],spec)
        self.assertEqual(broker.validate_request(self.request())['screenshotPath'],'/workspace/preview.png')

    def test_request_and_utf8_artifacts_are_capped(self):
        with self.assertRaises(ValueError):
            broker.validate_request(b' '*(broker.MAX_REQUEST+1))
        with self.assertRaises(ValueError):
            broker.validate_request(self.request(output='😀'*(broker.MAX_SCREENSHOT//4+1)))
        accepted=broker.validate_request(self.request(output='a'*broker.MAX_SCREENSHOT))
        self.assertEqual(len(accepted['output']),broker.MAX_SCREENSHOT)

    def test_invalid_kinds_output_and_spec_are_rejected(self):
        for value in [{'kind':'shell'},{'output':{}},{'spec':[]},{'spec':None}]:
            with self.subTest(value=value),self.assertRaises(ValueError):
                broker.validate_request(self.request(**value))

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'Requires POSIX bounded file reads')
    def test_artifacts_reject_links_and_byte_overflow(self):
        with tempfile.TemporaryDirectory() as root:
            file=Path(root)/'image';file.write_bytes(b'12345')
            self.assertEqual(broker.read_regular(file,5),b'12345')
            with self.assertRaises(ValueError):
                broker.read_regular(file,4)
            link=Path(root)/'link';link.symlink_to(file)
            with self.assertRaises(OSError):
                broker.read_regular(link,5)
            hard=Path(root)/'hard';os.link(file,hard)
            with self.assertRaises(ValueError):
                broker.read_regular(file,5)

    def test_supervision_caps_response_and_diagnostics_before_extension(self):
        class Selector:
            def __init__(self):self.streams=[]
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def register(self,stream,_events,name):self.streams.append(types.SimpleNamespace(fd=stream,fileobj=stream,data=name))
            def get_map(self):return self.streams
            def select(self,_timeout):return [(self.streams[0],None)]
            def unregister(self,stream):self.streams=[key for key in self.streams if key.fileobj!=stream]
        child=types.SimpleNamespace(stdout=1,stderr=2,wait=lambda **_:0)
        for name,limit in [('stdout',broker.MAX_RESPONSE),('stderr',broker.MAX_DIAGNOSTICS)]:
            if name=='stderr':child.stdout=None;child.stderr=2
            else:child.stdout=1;child.stderr=2
            # stdout EOF immediately exposes the stderr stream in the second case.
            chunks=iter(([b''] if name=='stderr' else [])+[b'a'*8192]*(limit//8192+1))
            with patch.object(broker.selectors,'DefaultSelector',Selector),patch.object(broker.os,'read',side_effect=lambda *_:next(chunks)):
                with self.assertRaises(ValueError):broker.supervise(child,1)

    def test_renderer_digests_come_from_one_complete_bench_digest_pass(self):
        files=[Path('/opt/distill-browser/a b'),Path('/opt/distill-browser/c')]
        answer=lambda lines:types.SimpleNamespace(stdout=''.join(line+'\n' for line in lines).encode())
        digest=lambda value,path:f'{value} {path}'
        with patch.object(broker.subprocess,'run',return_value=answer([digest('a'*64,path) for path in files])) as run:
            self.assertEqual(broker.digests(files),{str(path):'a'*64 for path in files})
        self.assertEqual(run.call_args.args[0],['/usr/local/sbin/bench-digest','browser',*map(str,files)])
        for bad in [[digest('a'*64,files[0])],[digest('-',files[0]),digest('a'*64,files[1])],
                    [digest('a'*64,files[1]),digest('a'*64,files[0])],[digest('A'*64,files[0]),digest('a'*64,files[1])]]:
            with patch.object(broker.subprocess,'run',return_value=answer(bad)):
                with self.assertRaises(ValueError):broker.digests(files)

if __name__=='__main__':
    unittest.main()
