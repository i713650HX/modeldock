// Minimal GGUF header parser.
// Reads only the metadata section from the head of a .gguf file — never the
// tensor data — so it stays fast even for 80 GB models.
const fs = require('fs');

const VALUE_TYPES = {
  0: 'uint8', 1: 'int8', 2: 'uint16', 3: 'int16', 4: 'uint32', 5: 'int32',
  6: 'float32', 7: 'bool', 8: 'string', 9: 'array', 10: 'uint64', 11: 'int64',
  12: 'float64',
};

// GGML file type -> human readable quantization name
// Source: llama.cpp ggml.h enum ggml_type
const FILE_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 4: 'Q4_2', 5: 'Q5_0', 6: 'Q5_1',
  7: 'Q8_0', 8: 'Q8_1', 9: 'Q2_K', 10: 'Q3_K_S', 11: 'Q3_K_M', 12: 'Q3_K_L',
  13: 'Q4_K_S', 14: 'Q4_K_M', 15: 'Q5_K_S', 16: 'Q5_K_M', 17: 'Q6_K', 18: 'Q8_K',
  19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'IQ3_XXS', 22: 'IQ1_S', 23: 'IQ4_NL',
  24: 'IQ3_S', 25: 'IQ2_S', 26: 'IQ4_XS', 27: 'Q8_KV', 28: 'IQ1_M', 29: 'BF16',
  30: 'Q4_0_4_4', 31: 'Q4_0_4_8', 32: 'Q4_0_8_8',
};

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  remaining() { return this.buf.length - this.pos; }
  u8() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  i8() { const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16() { const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64() {
    const v = Number(this.buf.readBigUInt64LE(this.pos));
    this.pos += 8;
    return v;
  }
  i64() {
    const v = Number(this.buf.readBigInt64LE(this.pos));
    this.pos += 8;
    return v;
  }
  f32() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  bool() { return this.u8() !== 0; }
  str() {
    const len = this.u64();
    if (len < 0 || len > 1024 * 1024 || this.pos + len > this.buf.length) {
      throw new Error('invalid string length');
    }
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

function readValue(r, type, depth) {
  if (depth > 3) throw new Error('value nesting too deep');
  switch (type) {
    case 0: return r.u8();
    case 1: return r.i8();
    case 2: return r.u16();
    case 3: return r.i16();
    case 4: return r.u32();
    case 5: return r.i32();
    case 6: return r.f32();
    case 7: return r.bool();
    case 8: return r.str();
    case 10: return r.u64();
    case 11: return r.i64();
    case 12: return r.f64();
    case 9: {
      const elemType = r.u32();
      const count = r.u64();
      if (count > 100000) throw new Error('array too large');
      const out = [];
      for (let i = 0; i < count; i++) {
        out.push(readValue(r, elemType, depth + 1));
      }
      return out;
    }
    default: throw new Error('unknown value type ' + type);
  }
}

function parseGGUF(filePath) {
  const result = {
    ok: false,
    version: null,
    architecture: null,
    name: null,
    quantization: null,
    fileType: null,
    contextLength: null,
    vocabSize: null,
    blockCount: null,
    parameterCount: null,
    tensorCount: null,
    error: null,
  };

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    // Metadata is at the head. 2 MB covers virtually all GGUF models.
    const readLen = Math.min(stat.size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
    fd = null;

    if (bytesRead < 24) {
      result.error = 'file too small';
      return result;
    }

    const r = new Reader(buf.subarray(0, bytesRead));
    const magic = buf.toString('ascii', 0, 4);
    if (magic !== 'GGUF') {
      result.error = 'not a GGUF file';
      return result;
    }
    r.pos = 4;
    result.version = r.u32();
    if (result.version < 2 || result.version > 3) {
      result.error = 'unsupported GGUF version ' + result.version;
      return result;
    }
    result.tensorCount = r.u64();
    const kvCount = r.u64();
    if (kvCount > 5000) {
      result.error = 'invalid kv count';
      return result;
    }

    const kv = {};
    for (let i = 0; i < kvCount; i++) {
      if (r.remaining() < 16) break;
      const key = r.str();
      const type = r.u32();
      let value;
      try {
        value = readValue(r, type, 0);
      } catch (err) {
        break;
      }
      kv[key] = value;
    }

    result.architecture = kv['general.architecture'] || null;
    result.name = kv['general.name'] || null;
    const ft = kv['general.file_type'];
    if (ft !== undefined && ft !== null) {
      result.fileType = ft;
      result.quantization = FILE_TYPES[ft] || ('type_' + ft);
    }

    const arch = result.architecture;
    if (arch) {
      const ctx = kv[arch + '.context_length'];
      if (ctx !== undefined) result.contextLength = ctx;
      const vocab = kv[arch + '.vocab_size'];
      if (vocab !== undefined) result.vocabSize = vocab;
      const blocks = kv[arch + '.block_count'];
      if (blocks !== undefined) result.blockCount = blocks;
    }

    // Try to compute parameter count from tensor shapes if metadata lacks it.
    // n_params ~= sum of tensor element counts. We only need a rough figure.
    if (kv['general.parameter_count'] !== undefined) {
      result.parameterCount = kv['general.parameter_count'];
    } else if (result.blockCount && result.architecture) {
      const a = result.architecture;
      const embd = kv[a + '.embedding_length'] || 0;
      const ff = kv[a + '.feed_forward_length'] || 0;
      const heads = kv[a + '.attention.head_count'] || 0;
      const kvHeads = kv[a + '.attention.head_count_kv'] || heads;
      const experts = kv[a + '.expert_count'] || 0;
      if (embd && ff && heads) {
        // approx per-block: attn (4*embd^2) + ff (3*embd*ff), times blocks
        let perBlock = 4 * embd * embd + 3 * embd * ff;
        if (experts > 0) perBlock = 4 * embd * embd + 3 * embd * ff * experts;
        result.parameterCount = Math.round(result.blockCount * perBlock / 1e9 * 10) / 10 * 1e9;
      }
    }

    result.ok = true;
  } catch (err) {
    result.error = err.message || String(err);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
  return result;
}

module.exports = { parseGGUF, FILE_TYPES };
