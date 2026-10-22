"""Extract the unmirrored arm and horn from the user's 2026-10-22 complete pose."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def outline_mask(size):
    # Source-space contour. The short open shoulder cut lies under the book's
    # left edge; the fingers, thumb and prop keep their supplied pixels.
    commands = [
        ('M', (317, 505)),
        ('C', (375, 505), (413, 558), (436, 610)),
        ('C', (554, 735), (752, 837), (900, 882)),
        ('C', (919, 858), (947, 865), (967, 896)),
        ('C', (994, 931), (990, 984), (962, 1010)),
        ('C', (944, 1029), (924, 1009), (918, 994)),
        ('L', (743, 996)), ('L', (744, 1073)),
        ('C', (778, 1057), (803, 1088), (798, 1123)),
        ('C', (797, 1158), (777, 1187), (744, 1178)),
        ('L', (711, 1298)),
        ('C', (704, 1343), (640, 1353), (614, 1319)),
        ('L', (619, 1288)),
        ('C', (563, 1322), (501, 1339), (451, 1322)),
        ('C', (400, 1310), (382, 1271), (394, 1218)),
        ('C', (405, 1160), (455, 1090), (501, 1071)),
        ('L', (469, 1162)), ('L', (573, 1110)),
        ('C', (560, 1084), (565, 1057), (597, 1038)),
        ('C', (614, 1030), (631, 1031), (642, 1034)),
        ('L', (645, 1005)),
        ('C', (516, 1016), (416, 1056), (343, 1108)),
        ('C', (306, 1148), (247, 1147), (213, 1104)),
        ('C', (135, 1019), (110, 880), (129, 757)),
        ('C', (145, 639), (212, 510), (289, 504)),
        ('C', (300, 502), (310, 502), (317, 505)),
    ]
    points = []; current = (0, 0)
    for command in commands:
        op, *values = command
        if op in ('M', 'L'):
            current = values[0]; points.append(current)
        else:
            a = np.array(current, dtype=float); b, c, d = map(lambda x: np.array(x,dtype=float), values)
            for t in np.linspace(0, 1, 48)[1:]:
                points.append(tuple((1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d))
            current = values[-1]
    factor = 4
    mask = Image.new('L', (size[0]*factor, size[1]*factor))
    ImageDraw.Draw(mask).polygon([(round(x*factor), round(y*factor)) for x,y in points], fill=255)
    return mask.resize(size, Image.Resampling.LANCZOS)


def matte(source):
    rgb = np.asarray(source.convert('RGB')).astype(np.float32)
    darkness = 255-rgb.min(axis=2)
    mask=outline_mask(source.size)
    boundary = Image.fromarray(np.uint8((darkness >= 32) & (np.asarray(mask)>127))*255, 'L')
    ImageDraw.Draw(boundary).line([(501,1071),(469,1162)],fill=255,width=3)
    ImageDraw.floodfill(boundary, (0,0), 128)
    interior = Image.fromarray(np.uint8(np.asarray(boundary) != 128)*255, 'L')
    near = np.asarray(interior.filter(ImageFilter.MaxFilter(3))) > 0
    core = np.asarray(interior.filter(ImageFilter.MinFilter(3))) > 0
    edge = np.asarray(source.convert('RGB').filter(ImageFilter.MinFilter(3))).astype(np.float32)
    coverage = np.clip(darkness / np.maximum(1,255-edge.min(axis=2)),0,1)
    alpha = np.where(core,1,coverage)
    alpha = np.where(near & (alpha >= .03),alpha,0)
    alpha *= np.asarray(mask)/255
    # The book spine behind the original arm is not part of the holding sprite.
    yy,xx=np.indices(alpha.shape)
    cool=rgb[:,:,2]>rgb[:,:,0]+12
    alpha=np.where(cool & (((xx>500)&(xx<565)&(yy>1065))|((xx<610)&(yy>1282))),0,alpha)
    # Follow the supplied navy barrel outline where it crosses the blue spine.
    curve=[]
    for t in np.linspace(0,1,800):
        q=(1-t)**3*np.array([436,610])+3*(1-t)**2*t*np.array([554,735])+3*(1-t)*t*t*np.array([752,837])+t**3*np.array([900,882])
        curve.append(q)
    curve=np.array(curve)
    for x in range(450,900):
        predicted=round(float(np.interp(x,curve[:,0],curve[:,1])))
        lo=max(0,predicted-22); hi=min(rgb.shape[0],predicted+23)
        col=rgb[lo:hi,x]
        edge=(col[:,0]<90)&(col[:,1]<125)&(col[:,2]<170)&(col[:,2]>col[:,0]+22)
        hits=np.where(edge)[0]
        if len(hits): alpha[:lo+hits[-1]-5,x]=0
    color = np.clip((rgb-255*(1-alpha[...,None]))/np.maximum(alpha[...,None],.001),0,255)
    rgba = Image.fromarray(np.dstack((color,alpha*255)).round().astype('uint8'),'RGBA')
    box = rgba.getbbox()
    return rgba.crop(box), box


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--assets',type=Path)
    args=parser.parse_args()
    source=Image.open(args.source).convert('RGB')
    if source.size != (2048,2048):
        raise ValueError('Expected the supplied 2048 x 2048 complete Banban pose.')
    args.output.mkdir(parents=True,exist_ok=True)
    sprite,box=matte(source)
    sprite.save(args.output/'holding-supplied.png')
    sprite.save(args.output/'holding-supplied.webp',lossless=True,method=6)
    if args.assets:
        args.assets.mkdir(parents=True,exist_ok=True)
        sprite.save(args.assets/'holding-supplied.webp',lossless=True,method=6)
    metadata={'source':args.source.name,'sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
              'sourceSize':source.size,'crop':box,'spriteSize':sprite.size,
              'shoulder':[487-box[0],1117-box[1]],'mouthpiece':[978-box[0],944-box[1]],
              'grip':[663-box[0],1168-box[1]],'mirrored':False}
    (args.output/'extraction.json').write_text(json.dumps(metadata,indent=2),encoding='utf-8')
    bg=Image.new('RGBA',sprite.size,'#DDE8EF'); bg.alpha_composite(sprite)
    bg.convert('RGB').save(args.output/'extracted-review.png')
    print(json.dumps(metadata))


if __name__=='__main__': main()
