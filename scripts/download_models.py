"""Download the two optional local models, checking the pinned SHA-256 values."""
import hashlib
import os
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent / 'models'
FILES = {
    'food101.onnx': ('https://huggingface.co/onnx-community/swin-finetuned-food101-ONNX/resolve/main/onnx/model_quantized.onnx', 'a80994b195389eb16c6bfd65e55841e888bb09886e86dce0957e124ad44c64a8'),
    'food101-config.json': ('https://huggingface.co/onnx-community/swin-finetuned-food101-ONNX/resolve/main/config.json', '6a5aca5f46b61c07e36521af58fd67ec6c4c7318b319db3c2e01fa7908fa7d26'),
    'u2netp.onnx': ('https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx', '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'),
}


def checksum(path):
    result=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): result.update(chunk)
    return result.hexdigest()


def main():
    ROOT.mkdir(exist_ok=True)
    for name,(url,expected) in FILES.items():
        dest=ROOT/name
        if dest.is_file() and checksum(dest)==expected:
            print(f'{name}: 已验证'); continue
        temp=dest.with_suffix(dest.suffix+'.part')
        print(f'{name}: 下载中',flush=True)
        try:
            with urlopen(url,timeout=60) as response, temp.open('wb') as output:
                while chunk:=response.read(1024*1024): output.write(chunk)
            if checksum(temp)!=expected: raise ValueError(f'{name}: 校验失败')
            os.replace(temp,dest)
            print(f'{name}: 已验证')
        finally:
            temp.unlink(missing_ok=True)


if __name__=='__main__': main()
