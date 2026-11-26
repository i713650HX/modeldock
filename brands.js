// GPU brand recognition — covers international and Chinese domestic brands.
// Ordered: most specific patterns first so e.g. "Moore Threads" is matched before generic terms.

const BRANDS = [
  // ---- 国产 / Chinese domestic ----
  { key: 'moorethreads', name: '摩尔线程 Moore Threads', short: '摩尔线程', origin: '国产', pattern: /moore\s*threads|mtt\s*s?\d|musa|m100|s80|s90/i },
  { key: 'biren', name: '壁仞科技 Biren', short: '壁仞', origin: '国产', pattern: /biren|br100|br104|br20|birentech/i },
  { key: 'metax', name: '沐曦 MetaX', short: '沐曦', origin: '国产', pattern: /metax|mxc\s?\d|c500|mx\s?\d{3}/i },
  { key: 'hygon', name: '海光 Hygon DCU', short: '海光', origin: '国产', pattern: /hygon|dcu|z100|k100/i },
  { key: 'jingjiawei', name: '景嘉微 JMG', short: '景嘉微', origin: '国产', pattern: /jingjiawei|jmg|jm5400|jm7200|jm9100|jm11/i },
  { key: 'enflame', name: '燧原 Enflame', short: '燧原', origin: '国产', pattern: /enflame|suiyuan|dtu|gcu\s?\d/i },
  { key: 'iluvatar', name: '天数智芯 Iluvatar', short: '天数智芯', origin: '国产', pattern: /iluvatar|corex|bi\s?\d+|gl\s?\d+/i },
  { key: 'denglin', name: '登临科技 Denglin', short: '登临', origin: '国产', pattern: /denglin|goldwasser|enki/i },
  { key: 'harbest', name: '瀚博半导体 Harbest', short: '瀚博', origin: '国产', pattern: /harbest|hb\s?\d{3}/i },
  { key: 'innosilicon', name: '芯动 Innosilicon', short: '芯动', origin: '国产', pattern: /innosilicon|fantasy|axis\s?\d/i },
  { key: 'loongson', name: '龙芯 Loongson', short: '龙芯', origin: '国产', pattern: /loongson|lg100|7a\d{3}|2k\d{3}/i },
  { key: 'zhaoxin', name: '兆芯 Zhaoxin', short: '兆芯', origin: '国产', pattern: /zhaoxin|kx\s?\d{4}/i },
  { key: 'rockchip', name: '瑞芯微 Rockchip', short: '瑞芯微', origin: '国产', pattern: /rockchip|rk\d{4}/i },
  { key: 'allwinner', name: '全志 Allwinner', short: '全志', origin: '国产', pattern: /allwinner|sun\d+i/i },
  { key: 'phytium', name: '飞腾 Phytium', short: '飞腾', origin: '国产', pattern: /phytium|ft\d{4}/i },
  { key: 'vastai', name: '瀚辰 Vastai', short: '瀚辰', origin: '国产', pattern: /vastai|vg\s?\d{3}/i },

  // ---- 国外 / International ----
  { key: 'nvidia', name: '英伟达 NVIDIA', short: 'NVIDIA', origin: '国外', pattern: /nvidia|geforce|quadro|tesla|rtx\s?\d|gtx\s?\d|grid\s|titan|a100|h100|h200|l40|t4\b/i },
  { key: 'amd', name: '超威 AMD / ATI', short: 'AMD', origin: '国外', pattern: /amd|radeon|\brx\s?\d|rxvega|firepro|instinct|mi\d{2,3}|vega\s?\d/i },
  { key: 'intel', name: '英特尔 Intel', short: 'Intel', origin: '国外', pattern: /intel|uhd\s?graphics|iris|hd\s?graphics|arc\s?[ab]\d|gma\b/i },
  { key: 'matrox', name: 'Matrox', short: 'Matrox', origin: '国外', pattern: /matrox/i },
  { key: '3dfx', name: '3dfx', short: '3dfx', origin: '国外', pattern: /3dfx|voodoo/i },
  { key: 's3', name: 'S3', short: 'S3', origin: '国外', pattern: /\bs3\b|trident|viRGE/i },
  { key: 'cirrus', name: 'Cirrus Logic', short: 'Cirrus', origin: '国外', pattern: /cirrus/i },
  { key: 'qualcomm', name: '高通 Qualcomm Adreno', short: '高通', origin: '国外', pattern: /qualcomm|adreno/i },
  { key: 'arm', name: 'ARM Mali', short: 'ARM', origin: '国外', pattern: /mali-\d|mali\s?t/i },
  { key: 'apple', name: 'Apple GPU', short: 'Apple', origin: '国外', pattern: /apple\s?gpu/i },
];

// Recognize brand from a GPU name string.
function detectBrand(name) {
  if (!name) return { key: 'unknown', name: '未知品牌', short: '未知', origin: '未知' };
  for (const b of BRANDS) {
    if (b.pattern.test(name)) return { key: b.key, name: b.name, short: b.short, origin: b.origin };
  }
  return { key: 'unknown', name: '其它品牌', short: '其它', origin: '未知' };
}

// Integrated GPU detection (shared system memory, not dedicated VRAM).
function isIntegrated(name) {
  const brand = detectBrand(name);
  const integratedBrands = ['intel', 'loongson', 'zhaoxin', 'rockchip', 'allwinner', 'phytium', 'qualcomm', 'arm', 'apple'];
  if (integratedBrands.includes(brand.key)) return true;
  // AMD/Intel integrated graphics names, but not discrete RX / Arc
  return /(uhd|iris|hd\s?graphics|vega\s?\d+\s?graphics|radeon\s?graphics|amd\s?graphics)/i.test(name) &&
    !/(radeon\s?rx|arc\s?[ab]\d|quadro|rtx\s?\d|gtx\s?\d)/i.test(name);
}

module.exports = { BRANDS, detectBrand, isIntegrated };
