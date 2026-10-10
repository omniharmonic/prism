import argparse,json,hashlib,pathlib,urllib.request,time
parser=argparse.ArgumentParser(description='Download pinned synthetic-evaluation assets only')
parser.add_argument('--cache',type=pathlib.Path,default=pathlib.Path('/private/tmp/omni-kokoro-cache'))
args=parser.parse_args()
root=args.cache
files=json.loads(pathlib.Path(__file__).with_name('asset-manifest.json').read_text())
budget=750_000_000; transferred=0; started=time.monotonic()
def matches(data,f):
 if len(data)!=f['size']: return False
 if f.get('sha256'): return hashlib.sha256(data).hexdigest()==f['sha256']
 return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==f['gitBlob']
for i,f in enumerate(files,1):
 target=root/f['local'];target.parent.mkdir(parents=True,exist_ok=True)
 if target.exists() and matches(target.read_bytes(),f):continue
 if transferred+f['size']>budget:raise RuntimeError('Download budget exceeded')
 url='https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/'+f['revision']+'/'+f['remote']
 with urllib.request.urlopen(url,timeout=120) as response:
  data=response.read(f['size']+1);transferred+=len(data)
 if not matches(data,f):raise RuntimeError('Pinned checksum mismatch: '+f['remote'])
 target.write_bytes(data)
 print(str(i)+'/'+str(len(files))+' '+f['remote']+' '+str(len(data)),flush=True)
base=root/'Models/kokoro-82m-coreml/ANE-v3/6c0750dd02ef9d981fb82f147d784a3f171755ee/en'
(base/'base-index-v3.json').write_bytes(pathlib.Path(__file__).with_name('base-index.json').read_bytes())
receipt={'transferredBytes':transferred,'knownBytes':sum(f['size'] for f in files),'seconds':time.monotonic()-started,'budgetBytes':budget,'files':len(files),'allPinnedChecksumsVerified':True}
(root/'download-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt),flush=True)
