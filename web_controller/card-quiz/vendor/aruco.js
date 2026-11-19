/* ICeClass adaptation: UMD packaging; QCMCam2 dd161a7e9661ca5028757d69740152398a5e4c22. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cv.js'));else root.ICeCardAR=factory(root.ICeCardCV);})(globalThis,function(CV){
// @ts-nocheck vendored library, not written for type-checking — see CLAUDE.md
/*
Copyright (c) 2020 Damiano Falcioni
Copyright (c) 2011 Juan Mellado

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

/*
References:
- "ArUco: a minimal library for Augmented Reality applications based on OpenCv"
  http://www.uco.es/investiga/grupos/ava/node/26
- "js-aruco: a port to JavaScript of the ArUco library"
  https://github.com/jcmellado/js-aruco
*/


const AR = {}
// mettre un tau à 1 évite les faux positifs
AR.DICTIONARIES = {
  QCMCAM_4X4_157h3: {
    nBits: 16,
    tau: 1,
    codeList: [47103, 18431, 56687, 32679, 62383, 12255, 14847, 59199, 32367, 62175, 44983, 61823, 43647, 46791, 51519, 15987, 27319, 7087, 28431, 36087, 44487, 28055, 55751, 36711, 52647, 23735, 53991, 48159, 30879, 20406, 25727, 50647, 25439, 7895, 41463, 22111, 15303, 31443, 33743, 34173, 42159, 20195, 19317, 13531, 39603, 52779, 3647, 6781, 34427, 46187, 35751, 42227, 7287, 50071, 5551, 3991, 22631, 9527, 34203, 36959, 9171, 18341, 49515, 3279, 12471, 44299, 40131, 36487, 39141, 447, 3569, 10583, 9907, 55311, 9019, 13027, 31365, 51287, 12879, 35733, 18315, 27971, 24935, 34975, 30215, 4587, 42071, 11925, 4767, 21647, 45651, 50759, 57615, 3926, 34723, 19335, 9462, 20903, 27207, 26403, 10119, 9831, 12051, 20695, 17743, 27701, 27537, 29741, 5243, 19547, 6715, 17979, 10543, 19685, 41639, 3915, 10661, 16943, 7431, 25797, 37927, 2171, 5675, 247, 32879, 51719, 8379, 34581, 25251, 27659, 5299, 877, 10343, 4663, 38987, 3853, 2859, 9035, 36163, 8934, 29253, 33373, 13447, 24790, 37091, 25881, 24937, 49447, 23051, 20006, 9611, 34499, 2531, 9585, 33237, 1462, 18995]
  },
  QCMCAM_4X4_90h4: {
    nBits: 16,
    tau: 1,
    codeList: [[251, 187], [254, 218], [103, 223], [118, 175], [254, 71], [158, 207], [95, 151], [111, 229], [187, 124], [183, 171], [247, 77], [121, 205], [207, 86], [46, 235], [45, 63], [126, 27], [182, 91], [191, 200], [211, 213], [233, 93], [158, 46], [249, 145], [14, 183], [108, 94], [204, 213], [52, 111], [87, 178], [240, 203], [4, 255], [13, 246], [147, 122], [159, 161], [202, 31], [197, 55], [249, 37], [238, 42], [53, 117], [181, 50], [15, 154], [51, 45], [84, 158], [196, 242], [38, 62], [221, 130], [172, 228], [104, 103], [97, 233], [217, 88], [138, 173], [153, 70], [17, 167], [42, 15], [70, 101], [134, 139], [176, 43], [148, 113], [165, 84], [24, 117], [28, 90], [56, 178], [75, 100], [85, 104], [93, 65], [107, 18], [139, 162], [133, 156], [156, 137], [201, 98], [204, 152], [199, 160], [36, 177], [8, 174], [23, 24], [50, 140], [36, 232], [80, 46], [81, 148], [132, 108], [133, 42], [188, 4], [33, 35], [68, 21], [9, 41], [42, 40], [80, 19], [97, 36], [131, 68], [102, 0], [104, 1], [128, 160]]
  },
  // Cartes du projet live-quiz (forge.apps.education.fr) : 50 marqueurs, distance de
  // Hamming >= 4 toutes rotations confondues. Codes = matrice d'origine (1 = noir)
  // inversée bit à bit, car ici 1 = cellule blanche (cf. generateCANVAS).
  LIVEQUIZ_4X4_50: {
    nBits: 16,
    tau: 1,
    codeList: [62495, 61775, 60943, 59959, 59679, 59159, 58767, 58727, 58159, 58071, 57535, 56967, 56423, 56103, 55895, 55867, 55751, 55111, 54939, 54839, 54575, 54047, 53991, 53499, 52647, 52595, 52559, 52287, 52119, 51823, 51155, 51115, 50895, 50459, 50423, 50039, 49647, 49247, 48803, 48715, 11595, 5721, 12591, 2735, 22142, 15569, 39039, 24105, 7710, 2526]
  },
  // Cartes de la première version de QCMCam (125 marqueurs, 4x4). Chaque ligne de la
  // grille est l'un des 4 motifs 0010, 0011, 1110, 1011 (1 = cellule blanche), le numéro
  // de carte en base 4 donnant le motif de chaque ligne (cf. qcmcam/generateur/markers4x4.js).
  // Distance de Hamming minimale de 1 toutes rotations confondues : aucune correction
  // d'erreur possible, lecture exacte seulement (maxHammingDistance 1).
  QCMCAM1_4X4_125: {
    nBits: 16,
    tau: 1,
    codeList: [16110,  16107,  16062,  16059,  15342,  15339,  15294,  15291,  58350,  58347,  58302,  58299,  60990,  60987,  61155,  58046,  61163,  61107,  61118,  61115,  60222,  60219,  60387,  60398,  60395,  60339,  60350,  60347,  46062,  46059,  46014,  46011,  48702,  48699,  48867,  48878,  48875,  48819,  48830,  48827,  47934,  47931,  48099,  48110,  48107,  48062,  12011,  11966,  11963,  11246,  11243,  11198,  13291,  13246,  15934,  15931,  16099,  16051,  15166,  15331,  12014,  11195,  13294,  13243,  15163,  15283,  58094,  58091,  46051,  58043,  58174,  58171,  58339,  58291,  60974,  60971,  60979,  61154,  61106,  60206,  60203,  60211,  60386,  60338,  45806,  45803,  45758,  45755,  45886,  45883,  11838,  46003,  48686,  48683,  48691,  48866,  48818,  47918,  47915,  47923,  48098,  48050,  12990,  15918,  15915,  16050,  15150,  15147,  15330,  57915,  58083,  58035,  58158,  58155,  58338,  58290,  60978,  60195,  60210,  45630,  45747,  45867,  46050,  46002,  48690]
  }
}

AR.Dictionary = function (dicName) {
  this.codes = {}
  this.codeList = []
  this.tau = 0
  this._initialize(dicName)
}

AR.Dictionary.prototype._initialize = function (dicName) {
  this.codes = {}
  this.codeList = []
  this.tau = 0
  this.nBits = 0
  this.markSize = 0
  this.dicName = dicName
  const dictionary = AR.DICTIONARIES[dicName]
  if (!dictionary) { throw 'The dictionary "' + dicName + '" is not recognized.' }

  this.nBits = dictionary.nBits
  this.markSize = Math.sqrt(dictionary.nBits) + 2
  for (let i = 0; i < dictionary.codeList.length; i++) {
    let code = null
    if (typeof dictionary.codeList[i] === 'number') { code = this._hex2bin(dictionary.codeList[i], dictionary.nBits) }
    if (typeof dictionary.codeList[i] === 'string') { code = this._hex2bin(parseInt(dictionary.codeList[i], 16), dictionary.nBits) }
    if (Array.isArray(dictionary.codeList[i])) { code = this._bytes2bin(dictionary.codeList[i], dictionary.nBits) }
    if (code === null) { throw 'Invalid code ' + i + ' in dictionary ' + dicName + ': ' + JSON.stringify(dictionary.codeList[i]) }
    if (code.length !== dictionary.nBits) { throw 'The code ' + i + ' in dictionary ' + dicName + ' is not ' + dictionary.nBits + ' bits long but ' + code.length + ': ' + code }
    this.codeList.push(code)
    this.codes[code] = {
      id: i
    }
  }
  this.tau = dictionary.tau || this._calculateTau()
}

AR.Dictionary.prototype.find = function (bits) {
  let val = ''
  let i; let j
  for (i = 0; i < bits.length; i++) {
    const bitRow = bits[i]
    for (j = 0; j < bitRow.length; j++) {
      val += bitRow[j]
    }
  }
  let minFound = this.codes[val]
  if (minFound) {
    return {
      id: minFound.id,
      distance: 0
    }
  }

  for (i = 0; i < this.codeList.length; i++) {
    const code = this.codeList[i]
    const distance = this._hammingDistance(val, code)
    if (distance < this.tau) {
      if (!minFound || minFound.distance > distance) {
        minFound = {
          id: this.codes[code].id,
          distance
        }
      }
    }
  }
  // Lecture corrigée d'un bit : on indique QUELLE cellule il a fallu corriger, pour que
  // l'appelant juge si cette correction est plausible (cf. Detector.getMarker)
  if (minFound && minFound.distance === 1) {
    minFound.cell = this._firstDifference(val, this.codeList[minFound.id])
  }
  return minFound
}

// Indice (ligne par ligne) de la première cellule qui diffère entre deux séquences de bits
AR.Dictionary.prototype._firstDifference = function (str1, str2) {
  for (let i = 0; i < str1.length; i++) {
    if (str1[i] !== str2[i]) return i
  }
  return -1
}

AR.Dictionary.prototype._hex2bin = function (hex, nBits) {
  return hex.toString(2).padStart(nBits, '0')
}

AR.Dictionary.prototype._bytes2bin = function (byteList, nBits) {
  let bits = ''; let byte
  for (byte of byteList) {
    bits += byte.toString(2).padStart(bits.length + 8 > nBits ? nBits - bits.length : 8, '0')
  }
  return bits
}

AR.Dictionary.prototype._hammingDistance = function (str1, str2) {
  if (str1.length !== str2.length) { throw 'Hamming distance calculation require inputs of the same length' }
  let distance = 0
  let i
  for (i = 0; i < str1.length; i++) {
    if (str1[i] !== str2[i]) { distance += 1 }
  }
  return distance
}

AR.Dictionary.prototype._calculateTau = function () {
  let tau = Number.MAX_VALUE
  for (let i = 0; i < this.codeList.length; i++) {
    for (let j = i + 1; j < this.codeList.length; j++) {
      const distance = this._hammingDistance(this.codeList[i], this.codeList[j])
      tau = distance < tau ? distance : tau
    }
  }
  return tau
}

AR.Dictionary.prototype.generateSVG = function (id) {
  const code = this.codeList[id]
  if (code == null) { throw 'The id "' + id + '" is not valid for the dictionary "' + this.dicName + '". ID must be between 0 and ' + (this.codeList.length - 1) + ' included.' }
  const size = this.markSize - 2
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (size + 4) + ' ' + (size + 4) + '">'
  svg += '<rect x="0" y="0" width="' + (size + 4) + '" height="' + (size + 4) + '" fill="white"/>'
  svg += '<rect x="1" y="1" width="' + (size + 2) + '" height="' + (size + 2) + '" fill="black"/>'
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (code[y * size + x] === '1') { svg += '<rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="1" height="1" fill="white"/>' }
    }
  }
  svg += '</svg>'
  return svg
}

AR.Dictionary.prototype.generateCANVAS = function (id, dimension) {
  const code = this.codeList[id]
  if (dimension === undefined) dimension = 200
  if (code == null) {
    throw 'The id "' + id + '" is not valid for the dictionary "' + this.dicName + '". ID must be between 0 and ' + (this.codeList.length - 1) + ' included.'
  }
  const size = this.markSize - 2
  const canvas = document.createElement('canvas')
  canvas.width = dimension
  canvas.height = dimension
  const unit = dimension / (size + 4)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, dimension, dimension)
  ctx.fillStyle = 'black'
  ctx.fillRect(unit, unit, unit * (size + 2), unit * (size + 2))
  ctx.fillStyle = 'white'
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (code[y * size + x] === '1') {
        ctx.fillRect(unit * (x + 2), unit * (y + 2), unit, unit)
      }
    }
  }
  return canvas
}

AR.Marker = function (id, corners, hammingDistance) {
  this.id = id
  this.corners = corners
  this.hammingDistance = hammingDistance
}

AR.Detector = function (config) {
  config = config || {}
  this.grey = new CV.Image()
  this.thres = new CV.Image()
  this.half = new CV.Image()
  this.halfThres = new CV.Image()
  this.homography = new CV.Image()
  this.binary = []
  this.halfBinary = []
  this.contours = []
  this.polys = []
  this.candidates = []
  config.dictionaryName = config.dictionaryName || 'QCMCAM_4X4_157h3'
  this.dictionary = new AR.Dictionary(config.dictionaryName)
  this.dictionary.tau = config.maxHammingDistance != null ? config.maxHammingDistance : this.dictionary.tau
  // Pixels ignorés de chaque côté d'une cellule (sur 8 dans le carré redressé de 49 px) :
  // une carte petite, floue ou mal calée déborde sur les cellules voisines, le centre reste fiable.
  // 0 = cellule entière (comportement d'origine).
  this.cellMargin = config.cellMargin != null ? config.cellMargin : 2
  // Une lecture à 1 bit d'erreur n'est acceptée que si la cellule à corriger est proche du seuil
  // noir/blanc : 0 = pile au seuil, 1 = franchement noire ou blanche. Une carte floue a bien une
  // cellule douteuse ; un panneau clair à bordure sombre, lui, est net partout, y compris à
  // l'endroit où il « diffère » du code de la carte 1. Infinity = toute correction acceptée.
  this.maxCorrectionConfidence = config.maxCorrectionConfidence != null ? config.maxCorrectionConfidence : 0.5
  // ... et seulement si cette cellule est parmi les plus douteuses des 16 : une vraie carte floue se
  // trompe sur l'une d'elles, un décor qui se trouve à un bit d'un code (la lettre « B » de
  // l'interface, une étiquette à chiffres) se trompe sur une cellule quelconque. Nombre maximal de
  // cellules plus douteuses que celle qu'on corrige (0 = la plus douteuse seulement). Infinity = pas de limite.
  this.maxCorrectionRank = config.maxCorrectionRank != null ? config.maxCorrectionRank : 1
  // ... et seulement si le quadrilatère est presque carré (rapport du plus grand au plus petit côté) :
  // un bandeau ou un badge trois fois plus large que haut n'est pas une carte vue de face. Une
  // lecture exacte, elle, n'est jamais refusée pour sa forme. Infinity = pas de limite.
  this.maxCorrectionAspect = config.maxCorrectionAspect != null ? config.maxCorrectionAspect : 2
}

AR.Detector.prototype.detectImage = function (width, height, data) {
  return this.detect({
    width,
    height,
    data
  })
}

AR.Detector.prototype.detectStreamInit = function (width, height, callback) {
  this.streamConfig = {}
  this.streamConfig.width = width
  this.streamConfig.height = height
  this.streamConfig.imageSize = width * height * 4 // provided image must be a sequence of rgba bytes (4 bytes represent a pixel)
  this.streamConfig.index = 0
  this.streamConfig.imageData = new Uint8ClampedArray(this.streamConfig.imageSize)
  this.streamConfig.callback = callback || function (image, markerList) {}
}

// accept data chunks of different sizes
AR.Detector.prototype.detectStream = function (data) {
  for (let i = 0; i < data.length; i++) {
    this.streamConfig.imageData[this.streamConfig.index] = data[i]
    this.streamConfig.index = (this.streamConfig.index + 1) % this.streamConfig.imageSize
    if (this.streamConfig.index === 0) {
      const image = {
        width: this.streamConfig.width,
        height: this.streamConfig.height,
        data: this.streamConfig.imageData
      }
      const markerList = this.detect(image)
      this.streamConfig.callback(image, markerList)
    }
  }
}

AR.Detector.prototype.detectMJPEGStreamInit = function (width, height, callback, decoderFn) {
  this.mjpeg = {
    decoderFn,
    chunks: [],
    SOI: [0xff, 0xd8],
    EOI: [0xff, 0xd9]
  }
  this.detectStreamInit(width, height, callback)
}

AR.Detector.prototype.detectMJPEGStream = function (chunk) {
  const eoiPos = chunk.findIndex(function (element, index, array) {
    return this.mjpeg.EOI[0] === element && array.length > index + 1 && this.mjpeg.EOI[1] === array[index + 1]
  })
  const soiPos = chunk.findIndex(function (element, index, array) {
    return this.mjpeg.SOI[0] === element && array.length > index + 1 && this.mjpeg.SOI[1] === array[index + 1]
  })

  if (eoiPos === -1) {
    this.mjpeg.chunks.push(chunk)
  } else {
    const part1 = chunk.slice(0, eoiPos + 2)
    if (part1.length) {
      this.mjpeg.chunks.push(part1)
    }
    if (this.mjpeg.chunks.length) {
      const jpegImage = this.mjpeg.chunks.flat()
      const rgba = this.mjpeg.decoderFn(jpegImage)
      this.detectStream(rgba)
    }
    this.mjpeg.chunks = []
  }
  if (soiPos > -1) {
    this.mjpeg.chunks = []
    this.mjpeg.chunks.push(chunk.slice(soiPos))
  }
}

// Tampons typés, alloués une fois par résolution et réutilisés d'une image à l'autre :
// les tableaux JS que CV.Image crée par défaut rendent grayscale + seuillage + contours
// environ 30 % plus lents (mesuré en 1080p : 26 ms contre 18 ms ; 4K : 112 ms contre 66 ms).
// `binary` reçoit des identifiants de contours négatifs, d'où Int32Array. Les tampons « half »
// sont ceux du second passage, sur l'image réduite de moitié (cf. findCoarseCandidates).
AR.Detector.prototype.allocateBuffers = function (width, height) {
  if (this.bufferWidth === width && this.bufferHeight === height) return
  const halfWidth = width >> 1
  const halfHeight = height >> 1
  this.bufferWidth = width
  this.bufferHeight = height
  this.grey = new CV.Image(width, height, new Uint8Array(width * height))
  this.thres = new CV.Image(width, height, new Uint8Array(width * height))
  this.binary = new Int32Array((width + 2) * (height + 2))
  this.half = new CV.Image(halfWidth, halfHeight, new Uint8Array(halfWidth * halfHeight))
  this.halfThres = new CV.Image(halfWidth, halfHeight, new Uint8Array(halfWidth * halfHeight))
  this.halfBinary = new Int32Array((halfWidth + 2) * (halfHeight + 2))
}

AR.Detector.prototype.detect = function (image) {
  this.allocateBuffers(image.width, image.height)
  CV.grayscale(image, this.grey)
  CV.adaptiveThreshold(this.grey, this.thres, 2, 7)

  this.contours = CV.findContours(this.thres, this.binary)
  // Scale Fix: https://stackoverflow.com/questions/35936397/marker-detection-on-paper-sheet-using-javascript
  // this.candidates = this.findCandidates(this.contours, image.width * 0.20, 0.05, 10);
//  this.candidates = this.findCandidates(this.contours, image.width * 0.01, 0.05, 10)
  this.candidates = this.findCandidates(this.contours, 12, 0.05, 10)
  this.candidates = this.clockwiseCorners(this.candidates)
  this.candidates = this.notTooNear(this.candidates, 10)

  const markers = this.findMarkers(this.grey, this.candidates, 49)
  // cartes grosses ou floues, que la recherche ci-dessus manque
  const coarseMarkers = this.findMarkers(this.grey, this.findCoarseCandidates(), 49)
  return this.mergeMarkers(markers.concat(coarseMarkers))
}

// Second passage de recherche de carrés, sur l'image réduite de moitié avec une fenêtre de
// seuillage de 7x7 (14x14 en pleine résolution) au lieu de 5x5. Le seuillage adaptatif ne retient
// que les pixels nettement plus sombres que leur voisinage : sur une carte grosse (bordure noire
// épaisse) ou floue, aucun pixel de la bordure ne l'est avec une fenêtre de 5x5, le contour est
// brisé ou absent et la carte n'est jamais trouvée (rappel de 8 à 28 % pour des cartes de 42 à
// 90 px dans une image floue et bruitée, 0 % pour 80 px et un flou de 2 px). Les coordonnées
// rendues sont celles de l'image d'origine.
AR.Detector.prototype.findCoarseCandidates = function () {
  if (this.half.width < 16 || this.half.height < 16) return []

  this.halve()
  CV.adaptiveThreshold(this.half, this.halfThres, 3, 7)
  const contours = CV.findContours(this.halfThres, this.halfBinary)
  let candidates = this.findCandidates(contours, 8, 0.05, 5)
  candidates = this.clockwiseCorners(candidates)
  candidates = this.notTooNear(candidates, 5)

  // le centre du pixel (x, y) de l'image réduite est entre les pixels 2x et 2x + 1 de l'image d'origine
  for (const candidate of candidates) {
    for (const corner of candidate) {
      corner.x = corner.x * 2 + 0.5
      corner.y = corner.y * 2 + 0.5
    }
  }

  return candidates
}

// Image réduite de moitié : moyenne de chaque bloc de 2x2 pixels
AR.Detector.prototype.halve = function () {
  const src = this.grey.data
  const width = this.grey.width
  const dst = this.half.data
  const halfWidth = this.half.width
  const halfHeight = this.half.height
  let x; let y; let s; let d

  for (y = 0; y < halfHeight; ++y) {
    s = 2 * y * width
    d = y * halfWidth
    for (x = 0; x < halfWidth; ++x, s += 2) {
      dst[d++] = (src[s] + src[s + 1] + src[s + width] + src[s + width + 1] + 2) >> 2
    }
  }
}

AR.Detector.prototype.findCandidates = function (contours, minSize, epsilon, minLength) {
  const candidates = []
  const len = contours.length
  let contour; let poly; let i

  this.polys = []

  for (i = 0; i < len; ++i) {
    contour = contours[i]

    if (contour.length >= minSize) {
      poly = CV.approxPolyDP(contour, contour.length * epsilon)

      this.polys.push(poly)

      if ((poly.length === 4) && (CV.isContourConvex(poly))) {
        if (CV.minEdgeLength(poly) >= minLength) {
          candidates.push(this.refineCorners(contour, poly))
        }
      }
    }
  }

  return candidates
}

// Droite ajustée (moindres carrés totaux) sur une suite de points : un point et une direction unitaire
function fitLine (points) {
  let meanX = 0; let meanY = 0
  for (const point of points) { meanX += point.x; meanY += point.y }
  meanX /= points.length
  meanY /= points.length
  let sxx = 0; let sxy = 0; let syy = 0
  for (const point of points) {
    const dx = point.x - meanX
    const dy = point.y - meanY
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { x: meanX, y: meanY, dx: Math.cos(angle), dy: Math.sin(angle) }
}

// Point d'intersection de deux droites de fitLine, null si elles sont presque parallèles
function intersectLines (a, b) {
  const det = a.dx * b.dy - a.dy * b.dx
  if (Math.abs(det) < 1e-6) return null
  const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / det
  return { x: a.x + t * a.dx, y: a.y + t * a.dy }
}

// Coins au sous-pixel. approxPolyDP ne retient que des pixels du contour : ses coins sont faux de
// près d'un pixel (arrondis par la binarisation), donc la grille de lecture est décalée, ce qui
// compte pour une petite carte ou pour le second passage (1 pixel de l'image réduite = 2 pixels).
// Ici chaque côté est une droite ajustée sur tout son arc de contour (les 15 % de chaque bout,
// arrondis, sont écartés) et chaque coin est l'intersection de deux côtés voisins. Rend le polygone
// d'origine quand l'ajustement n'est pas fiable (arc trop court, côtés parallèles, coin déplacé de
// plus de 3 px + 10 % de la diagonale).
AR.Detector.prototype.refineCorners = function (contour, poly) {
  const index = poly.map(vertex => contour.findIndex(point => point.x === vertex.x && point.y === vertex.y))
  if (index.some(i => i < 0)) return poly

  // les sommets du polygone ne sont pas rendus dans l'ordre du contour
  const order = [0, 1, 2, 3].sort((a, b) => index[a] - index[b])
  const total = contour.length
  const lines = []
  for (let k = 0; k < 4; ++k) {
    const from = index[order[k]]
    const length = (index[order[(k + 1) % 4]] - from + total) % total
    const trim = Math.max(1, Math.floor(length * 0.15))
    if (length < 6 || length - 2 * trim < 3) return poly
    const points = []
    for (let t = trim; t < length - trim; ++t) points.push(contour[(from + t) % total])
    lines.push(fitLine(points))
  }

  const diagonal = Math.hypot(poly[0].x - poly[2].x, poly[0].y - poly[2].y)
  const refined = []
  for (let k = 0; k < 4; ++k) {
    // le sommet order[k] est à la jonction du côté k - 1 et du côté k
    const corner = intersectLines(lines[(k + 3) % 4], lines[k])
    const original = poly[order[k]]
    if (corner === null || Math.hypot(corner.x - original.x, corner.y - original.y) > 3 + 0.1 * diagonal) return poly
    refined[order[k]] = corner
  }

  return refined
}

AR.Detector.prototype.clockwiseCorners = function (candidates) {
  const len = candidates.length
  let dx1; let dx2; let dy1; let dy2; let swap; let i

  for (i = 0; i < len; ++i) {
    dx1 = candidates[i][1].x - candidates[i][0].x
    dy1 = candidates[i][1].y - candidates[i][0].y
    dx2 = candidates[i][2].x - candidates[i][0].x
    dy2 = candidates[i][2].y - candidates[i][0].y

    if ((dx1 * dy2 - dy1 * dx2) < 0) {
      swap = candidates[i][1]
      candidates[i][1] = candidates[i][3]
      candidates[i][3] = swap
    }
  }

  return candidates
}

AR.Detector.prototype.notTooNear = function (candidates, minDist) {
  const notTooNear = []
  const len = candidates.length
  let dist; let dx; let dy; let i; let j; let k

  for (i = 0; i < len; ++i) {
    for (j = i + 1; j < len; ++j) {
      dist = 0

      for (k = 0; k < 4; ++k) {
        dx = candidates[i][k].x - candidates[j][k].x
        dy = candidates[i][k].y - candidates[j][k].y

        dist += dx * dx + dy * dy
      }

      if ((dist / 4) < (minDist * minDist)) {
        if (CV.perimeter(candidates[i]) < CV.perimeter(candidates[j])) {
          candidates[i].tooNear = true
        } else {
          candidates[j].tooNear = true
        }
      }
    }
  }

  for (i = 0; i < len; ++i) {
    if (!candidates[i].tooNear) {
      notTooNear.push(candidates[i])
    }
  }

  return notTooNear
}

AR.Detector.prototype.findMarkers = function (imageSrc, candidates, warpSize) {
  const markers = []
  const len = candidates.length
  let candidate; let marker; let i

  for (i = 0; i < len; ++i) {
    candidate = candidates[i]

    // carré redressé en niveaux de gris : getMarker en juge les cellules avec le seuil d'Otsu
    CV.warp(imageSrc, this.homography, candidate, warpSize)

    marker = this.getMarker(this.homography, candidate, CV.otsu(this.homography))
    if (marker) {
      markers.push(marker)
    }
  }

  return markers
}

// Keep one geometric result, but retain its observations so downstream stability checks can
// reject same-card orientation disagreements before scoring the best-distance reading.
AR.Detector.prototype.mergeMarkers = function (markers) {
  const kept = []

  for (const marker of markers) {
    const index = kept.findIndex(other => this.isSameSquare(other.corners, marker.corners))
    if (index < 0) {
      kept.push(marker)
    } else {
      const previous = kept[index]
      const observations = (previous.observations || [previous]).concat(marker.observations || [marker])
      const best = marker.hammingDistance < previous.hammingDistance ? marker : previous
      kept[index] = { ...best, observations }
    }
  }

  return kept
}

// Deux quadrilatères sont le même carré s'ils ont presque le même périmètre et que leurs centres
// sont à moins d'un quart de côté l'un de l'autre (des cartes voisines sont à plus d'un côté).
AR.Detector.prototype.isSameSquare = function (a, b) {
  const perimeterA = CV.perimeter(a)
  const perimeterB = CV.perimeter(b)
  const ratio = perimeterA / perimeterB
  if (ratio < 0.8 || ratio > 1.25) return false

  let dx = 0; let dy = 0
  for (let k = 0; k < 4; ++k) {
    dx += a[k].x - b[k].x
    dy += a[k].y - b[k].y
  }
  // (la somme des différences est la différence des sommes : l'ordre des sommets n'y change rien)
  return Math.hypot(dx / 4, dy / 4) < Math.min(perimeterA, perimeterB) / 16
}

/**
 * Lit un candidat redressé (carré de niveaux de gris, `threshold` = seuil noir/blanc).
 * Chaque cellule est jugée sur sa zone centrale (cf. cellMargin) : pixels plus clairs que le
 * seuil pour son bit, gris moyen pour la confiance de ce bit.
 */
AR.Detector.prototype.getMarker = function (imageSrc, candidate, threshold) {
  const markSize = this.dictionary.markSize
  const width = (imageSrc.width / markSize) >>> 0
  const margin = this.cellMargin
  const side = width - 2 * margin
  const minZero = (side * side) >> 1
  const light = []
  const mean = []
  const bits = []
  const confidence = []
  const rotations = []
  let i; let j; let x; let y
  let lowest = 255
  let highest = 0
  let borderErrors = 0
  const maxBorderErrors = 1

  for (i = 0; i < markSize; ++i) {
    light[i] = []
    mean[i] = []
    for (j = 0; j < markSize; ++j) {
      let count = 0
      let sum = 0
      for (y = i * width + margin; y < (i + 1) * width - margin; ++y) {
        for (x = j * width + margin; x < (j + 1) * width - margin; ++x) {
          const value = imageSrc.data[y * imageSrc.width + x]
          sum += value
          if (value > threshold) count++
        }
      }
      light[i][j] = count > minZero ? 1 : 0
      mean[i][j] = sum / (side * side)
      lowest = Math.min(lowest, mean[i][j])
      highest = Math.max(highest, mean[i][j])
      // la bordure du marqueur doit être noire (une cellule claire tolérée)
      if (light[i][j] === 1 && (i === 0 || j === 0 || i === markSize - 1 || j === markSize - 1)) {
        borderErrors++
        if (borderErrors > maxBorderErrors) return null
      }
    }
  }

  // Confiance dans chaque bit : écart du gris moyen au milieu noir/blanc du motif, ramené à
  // [0, 1] par la dynamique du motif (0 = cellule pile entre noir et blanc, 1 = franche).
  const middle = (lowest + highest) / 2
  const range = Math.max(1, highest - lowest)
  for (i = 0; i < markSize - 2; ++i) {
    bits[i] = []
    confidence[i] = []
    for (j = 0; j < markSize - 2; ++j) {
      bits[i][j] = light[i + 1][j + 1]
      confidence[i][j] = Math.min(1, 2 * Math.abs(mean[i + 1][j + 1] - middle) / range)
    }
  }

  // les confiances suivent les bits à chaque rotation
  rotations[0] = bits
  const rotatedConfidence = [confidence]

  let foundMin = null
  let rot = 0
  for (i = 0; i < 4; i++) {
    let found = this.dictionary.find(rotations[i])
    if (found && found.distance === 1 && !this.isCorrectionPlausible(rotatedConfidence[i], found.cell, candidate)) {
      found = null
    }
    if (found && (foundMin === null || found.distance < foundMin.distance)) {
      foundMin = found
      rot = i
      if (foundMin.distance === 0) { break }
    }
    rotations[i + 1] = this.rotate(rotations[i])
    rotatedConfidence[i + 1] = this.rotate(rotatedConfidence[i])
  }

  if (foundMin) { return new AR.Marker(foundMin.id, this.rotate2(candidate, 4 - rot), foundMin.distance) }

  return null
}

/**
 * Corriger un bit est un pari, qu'on ne prend que si les indices s'y prêtent : la cellule `cell`
 * (ligne par ligne, 0..15) doit être douteuse, parmi les plus douteuses des 16 (`confidences` :
 * matrice 4x4 de ses confiances), et le quadrilatère `candidate` presque carré. Cf. le constructeur.
 */
AR.Detector.prototype.isCorrectionPlausible = function (confidences, cell, candidate) {
  const confidence = confidences[(cell / 4) | 0][cell % 4]
  if (confidence > this.maxCorrectionConfidence) return false

  let moreDoubtful = 0
  for (const row of confidences) {
    for (const other of row) {
      if (other < confidence) moreDoubtful++
    }
  }
  if (moreDoubtful > this.maxCorrectionRank) return false

  let shortest = Infinity
  let longest = 0
  for (let k = 0; k < 4; ++k) {
    const side = Math.hypot(candidate[k].x - candidate[(k + 1) % 4].x, candidate[k].y - candidate[(k + 1) % 4].y)
    shortest = Math.min(shortest, side)
    longest = Math.max(longest, side)
  }
  return longest / shortest <= this.maxCorrectionAspect
}

AR.Detector.prototype.rotate = function (src) {
  const dst = []
  const len = src.length
  let i; let j

  for (i = 0; i < len; ++i) {
    dst[i] = []
    for (j = 0; j < src[i].length; ++j) {
      dst[i][j] = src[src[i].length - j - 1][i]
    }
  }

  return dst
}

AR.Detector.prototype.rotate2 = function (src, rotation) {
  const dst = []
  const len = src.length
  let i

  for (i = 0; i < len; ++i) {
    dst[i] = src[(rotation + i) % len]
  }

  return dst
}
return AR

});
