"""Pure local selected-input storage and JS/Python digest contract tests."""
import base64
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import tui_gateway
PAYLOAD = Path(__file__).resolve().parents[2] / 'resources/external-plugin-host-patches/hermes/v1-c7c2df1/patched/tui_gateway'
tui_gateway.__path__.insert(0, str(PAYLOAD))
from tui_gateway import selection_input as si
from tui_gateway import selection_dispatch as sd

class InputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sgh-input-unit-')
        self.home = Path(self.temp.name) / 'home'
        self.home.mkdir()
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()
        self.owner, self.operation = 'physical.owner', 'immutable.operation'
        self.text = '中文 🌱'
        self.payload = '本地内容'.encode()
        self.meta = dict(kind='file', name='你好.txt', mime_type='text/plain', size=len(self.payload), sha256=hashlib.sha256(self.payload).hexdigest())
        self.attachment = {**self.meta, 'data_base64':base64.b64encode(self.payload).decode()}
    def tearDown(self): self.temp.cleanup()
    def stage(self, **change):
        args = dict(home=str(self.home),owner=self.owner,operation=self.operation,workspace=str(self.workspace),text=self.text,attachments=[self.attachment])
        return si.stage(**{**args,**change})
    def code(self, code, fn):
        with self.assertRaises(sd.SelectionDispatchError) as caught:fn()
        self.assertEqual(caught.exception.code,code)
    def test_canonical_digest_matches_javascript_unicode_vector(self):
        receipt=self.stage()
        self.assertEqual(receipt['message_digest'],'28f06fa3dd28fdf717581cfa16d21f1de5526d405a98ea87ac7452693ebe8b03')
        self.assertEqual(receipt['attachment_digest'],'5c503a0ef670210e26e832ab1715e6b2333f213fe223b4b15a967e659d4e7fae')
        self.assertEqual(receipt['input_digest'],'5231c99e55c00be2ee5b58f1dca92af0de59dc879c04ebe2cc53cd458dad0cab')
        self.assertEqual(receipt['owner_session_id'],self.owner)
        self.assertNotIn('data_base64',json.dumps(receipt))
        self.assertNotIn(str(self.workspace),json.dumps(receipt))
    def test_immutable_retry_and_owner(self):
        receipt=self.stage()
        self.assertEqual(self.stage(),receipt)
        self.assertIsNone(si.get(str(self.home),'other.physical.owner',self.operation))
        self.code('SELECTION_INPUT_CONFLICT',lambda:self.stage(text='changed'))
        self.code('SELECTION_INPUT_CONFLICT',lambda:self.stage(attachments=[{**self.attachment,'name':'changed.txt'}]))
        text,images=si.for_submit(str(self.home),self.owner,self.operation,str(self.workspace),self.text,receipt['input_digest'])
        self.assertEqual(images,[])
        self.assertIn('@file:',text)
        self.assertIn(str(self.workspace),text)
        self.code('SELECTION_INPUT_CONFLICT',lambda:si.for_submit(str(self.home),self.owner,self.operation,str(self.workspace),'changed',receipt['input_digest']))
        self.code('SELECTION_INPUT_CONFLICT',lambda:si.for_submit(str(self.home),self.owner,self.operation,str(self.workspace),self.text,None))
    def test_changed_bytes_or_workspace_are_fenced(self):
        receipt=self.stage()
        other=self.workspace.parent/'other';other.mkdir()
        self.code('SELECTION_INPUT_OWNER_CHANGED',lambda:si.for_submit(str(self.home),self.owner,self.operation,str(other),self.text,receipt['input_digest']))
        file=next(self.workspace.rglob('00-*'));file.chmod(0o600);file.write_bytes(b'changed')
        self.code('SELECTION_INPUT_CHANGED',lambda:si.verify_before_model(str(self.home),self.owner,self.operation))
    def test_expired_inputs_are_not_reuploaded(self):
        receipt=self.stage()
        with patch.object(si.time,'time',return_value=receipt['expires_at']+1):
            self.code('SELECTION_INPUT_EXPIRED',self.stage)
            self.code('SELECTION_INPUT_EXPIRED',lambda:si.for_submit(str(self.home),self.owner,self.operation,str(self.workspace),self.text,receipt['input_digest']))
            self.assertEqual(si.get(str(self.home),self.owner,self.operation),receipt)
    def test_invalid_payload_and_pdf_publish_nothing(self):
        for item in [{**self.attachment,'name':'../escape'},{**self.attachment,'data_base64':'bad!'},
            {**self.attachment,'sha256':'0'*64}]:
            with self.assertRaises(sd.SelectionDispatchError):self.stage(attachments=[item])
        pdf=b'%PDF-invalid'
        item=dict(kind='pdf',name='fixture.pdf',mime_type='application/pdf',size=len(pdf),sha256=si.sha(pdf),data_base64=base64.b64encode(pdf).decode())
        with patch.object(si.shutil,'which',return_value=None):self.code('SELECTION_INPUT_PDF_UNAVAILABLE',lambda:self.stage(attachments=[item]))
        self.assertIsNone(si.get(str(self.home),self.owner,self.operation))
        self.assertFalse(list(self.workspace.rglob('.pending-*')))
    def test_atomic_publication_failure_is_closed(self):
        with patch.object(si.os,'rename',side_effect=OSError('unavailable')):
            with self.assertRaises(OSError):self.stage()
        self.assertIsNone(si.get(str(self.home),self.owner,self.operation))
        self.assertFalse(list(self.workspace.rglob('.pending-*')))
    def test_selected_empty_images_cannot_consume_session_media(self):
        text,images=si.for_submit(str(self.home),self.owner,self.operation,str(self.workspace),self.text,None)
        self.assertEqual((text,images),(self.text,[]))
        auto=(PAYLOAD/'session_auto_continue.py').read_text()
        self.assertIn('kwargs["image_paths"] = list(queued.get("image_paths") or [])',auto)
        self.assertIn('selection_image_paths',auto)
    def test_private_path_symlink_is_rejected(self):
        (self.workspace/'.shoggoth-selection-inputs').symlink_to(self.home,target_is_directory=True)
        self.code('SELECTION_INPUT_STORAGE_UNAVAILABLE',self.stage)
    def test_expired_file_capacity_is_reclaimed_without_reminting_receipt(self):
        receipt=self.stage()
        with patch.object(si,'MAX_OPERATIONS',1):
            self.code('SELECTION_INPUT_CAPACITY',lambda:self.stage(operation='next.operation'))
            with patch.object(si.time,'time',return_value=receipt['expires_at']+1):
                next_receipt=self.stage(operation='next.operation')
                self.assertNotEqual(next_receipt['operation_id'],receipt['operation_id'])
                self.assertEqual(si.get(str(self.home),self.owner,self.operation),receipt)
                self.code('SELECTION_INPUT_EXPIRED',self.stage)
        self.assertEqual(len(list(self.workspace.rglob('00-*'))),1)

    def test_stage_concurrency_is_bounded_before_any_decode_or_write(self):
        si._STAGE_SLOTS.acquire()
        try:self.code('SELECTION_INPUT_BUSY',self.stage)
        finally:si._STAGE_SLOTS.release()
        self.assertIsNone(si.get(str(self.home),self.owner,self.operation))

    def test_capacity_fails_before_publication(self):
        with patch.object(si,'MAX_OPERATIONS',0):self.code('SELECTION_INPUT_CAPACITY',self.stage)
        self.assertIsNone(si.get(str(self.home),self.owner,self.operation))

if __name__=='__main__':unittest.main()
