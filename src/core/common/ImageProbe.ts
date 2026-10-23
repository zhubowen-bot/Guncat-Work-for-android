// ImageProbe: 纯 TypeScript 的图片容器校验（不依赖 Electron / 原生解码器）。
//
// 为什么需要它：
//   view_image 以前只要文件存在、扩展名在白名单里、大小没超限，就**无条件**返回
//   「图片已加载」。一个 131 字节的纯文本改成 .png 也能“成功”，于是“成功”二字
//   不再代表任何信息 —— 真图有没有被解码、有没有送进模型，调用方完全看不出来。
//
// 这里按各格式的规范真正走一遍容器结构（魔数 / 尺寸 / 必需分块 / 结束标记），
// 再叠加平台解码器做二次确认（见 WorkFileService.toolViewImage）。
// 结构校验故意保留在纯 TS 层：无头冒烟测试没有 Electron，也必须能验证这条链路。
//
// 支持范围与 view_image 的白名单一致：png / jpeg / webp / gif / bmp。

export class ImageProbeResult {
  ok: boolean = false;
  // 实际格式（以字节内容为准，不信任扩展名）
  format: string = '';
  mime: string = '';
  width: number = 0;
  height: number = 0;
  error: string = '';
}

const PNG_SIGNATURE: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

function readU32BE(b: Uint8Array, o: number): number {
  // >>> 0: 避免最高位被解释成负数
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readI32LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let out: string = '';
  for (let i: number = 0; i < len; i++) {
    out += String.fromCharCode(b[o + i]);
  }
  return out;
}

function fail(r: ImageProbeResult, error: string): ImageProbeResult {
  r.ok = false;
  r.error = error;
  return r;
}

function succeed(r: ImageProbeResult, format: string, mime: string, width: number, height: number): ImageProbeResult {
  r.ok = true;
  r.format = format;
  r.mime = mime;
  r.width = width;
  r.height = height;
  return r;
}

// PNG: 8 字节签名 + IHDR(13 字节数据) + 至少一个 IDAT + IEND。
// 逐个分块走，长度字段必须落在文件内；缺 IDAT / IEND 的“只有文件头”的假图会被拒绝。
function probePng(bytes: Uint8Array, r: ImageProbeResult): ImageProbeResult {
  if (bytes.length < 8) {
    return fail(r, 'PNG 文件头不完整');
  }
  for (let i: number = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return fail(r, 'PNG 魔数不匹配');
    }
  }
  let off: number = 8;
  let sawIhdr: boolean = false;
  let sawIdat: boolean = false;
  let sawIend: boolean = false;
  let width: number = 0;
  let height: number = 0;
  while (off + 12 <= bytes.length) {
    let len: number = readU32BE(bytes, off);
    // 单块长度上限（PNG 规范：31 位）；也避免下面的加法溢出
    if (len > 0x7fffffff) {
      return fail(r, 'PNG 分块长度非法');
    }
    let type: string = ascii(bytes, off + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return fail(r, 'PNG 分块类型非法');
    }
    let dataStart: number = off + 8;
    let next: number = dataStart + len + 4; // 数据 + CRC
    if (next > bytes.length) {
      return fail(r, 'PNG 分块越界或文件被截断');
    }
    if (type === 'IHDR') {
      if (sawIhdr || len !== 13) {
        return fail(r, 'PNG IHDR 分块非法');
      }
      width = readU32BE(bytes, dataStart);
      height = readU32BE(bytes, dataStart + 4);
      let bitDepth: number = bytes[dataStart + 8];
      let colorType: number = bytes[dataStart + 9];
      if (width <= 0 || height <= 0) {
        return fail(r, 'PNG 尺寸非法');
      }
      if ([1, 2, 4, 8, 16].indexOf(bitDepth) < 0) {
        return fail(r, 'PNG 位深非法');
      }
      if ([0, 2, 3, 4, 6].indexOf(colorType) < 0) {
        return fail(r, 'PNG 颜色类型非法');
      }
      sawIhdr = true;
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'IEND') {
      if (len !== 0) {
        return fail(r, 'PNG IEND 分块非法');
      }
      sawIend = true;
      off = next;
      break;
    }
    off = next;
  }
  if (!sawIhdr) {
    return fail(r, 'PNG 缺少 IHDR');
  }
  if (!sawIdat) {
    return fail(r, 'PNG 缺少图像数据(IDAT)');
  }
  if (!sawIend) {
    return fail(r, 'PNG 文件不完整(缺少 IEND)');
  }
  return succeed(r, 'png', 'image/png', width, height);
}

// JPEG: SOI + 逐个 marker 走到 SOF（取尺寸）与 SOS（进入熵编码数据），末尾必须是 EOI。
function probeJpeg(bytes: Uint8Array, r: ImageProbeResult): ImageProbeResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return fail(r, 'JPEG 缺少 SOI');
  }
  let off: number = 2;
  let width: number = 0;
  let height: number = 0;
  let sawSof: boolean = false;
  let sawSos: boolean = false;
  let sosOffset: number = -1;
  while (off + 1 < bytes.length) {
    // marker 前允许任意数量的 0xFF 填充字节
    if (bytes[off] !== 0xff) {
      return fail(r, 'JPEG marker 结构非法');
    }
    while (off < bytes.length && bytes[off] === 0xff) {
      off++;
    }
    if (off >= bytes.length) {
      break;
    }
    let marker: number = bytes[off];
    off++;
    // 无长度字段的独立 marker
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue;
    }
    if (off + 1 >= bytes.length) {
      return fail(r, 'JPEG 文件被截断');
    }
    let segLen: number = readU16BE(bytes, off);
    if (segLen < 2 || off + segLen > bytes.length) {
      return fail(r, 'JPEG 分块长度非法');
    }
    let isSof: boolean = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (segLen < 8) {
        return fail(r, 'JPEG SOF 分块过短');
      }
      height = readU16BE(bytes, off + 3);
      width = readU16BE(bytes, off + 5);
      if (width <= 0 || height <= 0) {
        return fail(r, 'JPEG 尺寸非法');
      }
      sawSof = true;
    }
    if (marker === 0xda) {
      sawSos = true;
      sosOffset = off;
      break;
    }
    off += segLen;
  }
  if (!sawSof) {
    return fail(r, 'JPEG 缺少 SOF 尺寸信息');
  }
  if (!sawSos) {
    return fail(r, 'JPEG 缺少 SOS 图像数据');
  }
  // 允许 EOI 之后有少量尾随字节（部分相机/扫描软件会附加元数据），
  // 但 EOI 必须真的存在于图像数据之后，否则就是被截断的文件。
  let sawEoi: boolean = false;
  for (let i: number = sosOffset; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      sawEoi = true;
      break;
    }
  }
  if (!sawEoi) {
    return fail(r, 'JPEG 文件不完整(缺少 EOI)');
  }
  return succeed(r, 'jpeg', 'image/jpeg', width, height);
}

// GIF: 6 字节版本头 + 逻辑屏幕宽高；必须含图像描述符(0x2C)并以 0x3B 结束。
function probeGif(bytes: Uint8Array, r: ImageProbeResult): ImageProbeResult {
  if (bytes.length < 13) {
    return fail(r, 'GIF 文件头不完整');
  }
  let version: string = ascii(bytes, 0, 6);
  if (version !== 'GIF87a' && version !== 'GIF89a') {
    return fail(r, 'GIF 版本头非法');
  }
  let width: number = readU16LE(bytes, 6);
  let height: number = readU16LE(bytes, 8);
  if (width <= 0 || height <= 0) {
    return fail(r, 'GIF 尺寸非法');
  }
  // 跳过文件头 + 全局色表，再逐块走到第一个图像描述符。
  // 不能假设 0x2C 紧跟色表：动图常见的 NETSCAPE/注释扩展块会排在它前面。
  let flags: number = bytes[10];
  let off: number = 13;
  if ((flags & 0x80) !== 0) {
    off += 3 * (1 << ((flags & 0x07) + 1));
  }
  let sawImage: boolean = false;
  while (off < bytes.length) {
    let block: number = bytes[off];
    if (block === 0x2c) {
      // 图像描述符：0x2C + left/top/width/height(各 2 字节) + packed(1 字节)
      if (off + 10 > bytes.length) {
        return fail(r, 'GIF 图像描述符不完整');
      }
      let imageWidth: number = readU16LE(bytes, off + 5);
      let imageHeight: number = readU16LE(bytes, off + 7);
      if (imageWidth <= 0 || imageHeight <= 0) {
        return fail(r, 'GIF 图像尺寸非法');
      }
      // 图像数据之后必须有 trailer(0x3B)；允许尾随元数据，不要求它正好是最后一字节
      let sawTrailer: boolean = false;
      for (let i: number = off; i < bytes.length; i++) {
        if (bytes[i] === 0x3b) {
          sawTrailer = true;
          break;
        }
      }
      if (!sawTrailer) {
        return fail(r, 'GIF 文件不完整(缺少结束符)');
      }
      sawImage = true;
      break;
    }
    if (block === 0x21) {
      // 扩展块：0x21 + label，随后是若干「长度 + 数据」子块，以 0 长度结束
      off += 2;
      let ended: boolean = false;
      while (off < bytes.length) {
        let size: number = bytes[off];
        off++;
        if (size === 0) {
          ended = true;
          break;
        }
        off += size;
      }
      if (!ended || off > bytes.length) {
        return fail(r, 'GIF 扩展块结构非法');
      }
      continue;
    }
    // 0x3B 是文件结束符；到这里说明还没有图像数据
    break;
  }
  if (!sawImage) {
    return fail(r, 'GIF 缺少图像描述符');
  }
  return succeed(r, 'gif', 'image/gif', width, height);
}

// WebP: RIFF 容器 + VP8 / VP8L / VP8X 三种图像块之一。
function probeWebp(bytes: Uint8Array, r: ImageProbeResult): ImageProbeResult {
  if (bytes.length < 30) {
    return fail(r, 'WebP 文件过小');
  }
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return fail(r, 'WebP RIFF 头非法');
  }
  let riffSize: number = readU32LE(bytes, 4);
  if (riffSize + 8 > bytes.length) {
    return fail(r, 'WebP 文件被截断');
  }
  let chunk: string = ascii(bytes, 12, 4);
  let chunkSize: number = readU32LE(bytes, 16);
  if (chunkSize + 20 > bytes.length) {
    return fail(r, 'WebP 图像块越界');
  }
  let width: number = 0;
  let height: number = 0;
  if (chunk === 'VP8 ') {
    let data: number = 20;
    if (bytes.length < data + 10 || bytes[data + 3] !== 0x9d ||
      bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
      return fail(r, 'WebP VP8 帧头非法');
    }
    width = readU16LE(bytes, data + 6) & 0x3fff;
    height = readU16LE(bytes, data + 8) & 0x3fff;
  } else if (chunk === 'VP8L') {
    let data: number = 20;
    if (bytes.length < data + 5 || bytes[data] !== 0x2f) {
      return fail(r, 'WebP VP8L 帧头非法');
    }
    width = 1 + (((bytes[data + 2] & 0x3f) << 8) | bytes[data + 1]);
    height = 1 + (((bytes[data + 4] & 0x0f) << 10) |
      (bytes[data + 3] << 2) | ((bytes[data + 2] & 0xc0) >> 6));
  } else if (chunk === 'VP8X') {
    let data: number = 20;
    if (bytes.length < data + 10) {
      return fail(r, 'WebP VP8X 头过短');
    }
    width = 1 + readU24LE(bytes, data + 4);
    height = 1 + readU24LE(bytes, data + 7);
  } else {
    return fail(r, 'WebP 缺少 VP8/VP8L/VP8X 图像块');
  }
  if (width <= 0 || height <= 0) {
    return fail(r, 'WebP 尺寸非法');
  }
  return succeed(r, 'webp', 'image/webp', width, height);
}

// BMP: 文件头 + DIB 头；取像素数据偏移与宽高，并核对位深。
function probeBmp(bytes: Uint8Array, r: ImageProbeResult): ImageProbeResult {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return fail(r, 'BMP 缺少 BM 文件头');
  }
  let pixelOffset: number = readU32LE(bytes, 10);
  let dibSize: number = readU32LE(bytes, 14);
  let width: number = 0;
  let height: number = 0;
  let bpp: number = 0;
  if (dibSize === 12) {
    // BITMAPCOREHEADER: 16 位宽高，位深字段在偏移 24
    if (bytes.length < 26) {
      return fail(r, 'BMP 文件头不完整');
    }
    width = readU16LE(bytes, 18);
    height = readU16LE(bytes, 20);
    bpp = readU16LE(bytes, 24);
  } else if (dibSize >= 40) {
    if (bytes.length < 14 + dibSize) {
      return fail(r, 'BMP 文件被截断');
    }
    width = readI32LE(bytes, 18);
    height = readI32LE(bytes, 22);
    bpp = readU16LE(bytes, 28);
    // 高度为负表示自上而下存储，属于合法写法
    if (height < 0) {
      height = -height;
    }
  } else {
    return fail(r, 'BMP DIB 头长度不受支持');
  }
  if (width <= 0 || height === 0) {
    return fail(r, 'BMP 尺寸非法');
  }
  if ([1, 4, 8, 16, 24, 32].indexOf(bpp) < 0) {
    return fail(r, 'BMP 位深非法');
  }
  if (pixelOffset < 14 + dibSize || pixelOffset > bytes.length) {
    return fail(r, 'BMP 像素数据偏移非法');
  }
  return succeed(r, 'bmp', 'image/bmp', width, height);
}

export class ImageProbe {
  // 按内容而不是扩展名判断；未知/伪装成图片的文本会返回 ok=false 与可读的 error
  static probe(bytes: Uint8Array): ImageProbeResult {
    let r: ImageProbeResult = new ImageProbeResult();
    if (bytes.length === 0) {
      return fail(r, '文件为空');
    }
    if (bytes.length >= 8) {
      let isPng: boolean = true;
      for (let i: number = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) {
          isPng = false;
          break;
        }
      }
      if (isPng) {
        return probePng(bytes, r);
      }
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return probeJpeg(bytes, r);
    }
    if (bytes.length >= 6) {
      let head: string = ascii(bytes, 0, 6);
      if (head === 'GIF87a' || head === 'GIF89a') {
        return probeGif(bytes, r);
      }
    }
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      return probeWebp(bytes, r);
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return probeBmp(bytes, r);
    }
    return fail(r, '内容不是受支持的图片格式(png/jpg/jpeg/webp/gif/bmp)');
  }
}
