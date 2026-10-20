// 中綴じ・スクラム製本（二つ折りの紙を入れ子に重ねたもの）のスキャン画像と、
// 元のページ番号との対応を計算する。DOM や PDF ライブラリには依存しない。

/**
 * @typedef {Object} Options
 * @property {'left'|'right'} binding   左とじ（横書き）/ 右とじ（縦書き）
 * @property {'outside'|'inside'} firstFace  紙ごとに最初にスキャンされた面
 * @property {0|180} rotation           スキャン画像の向き（0 = 読める向き, 180 = 逆さま）
 * @property {boolean} backFlipped      裏面（2面目）だけさらに 180° 回っている
 * @property {0|90|270} quarterTurn     横向きにスキャンした場合の補正（時計回り）
 * @property {boolean} reverseSheets    紙の順番を既定と逆にする
 */

export const DEFAULT_OPTIONS = Object.freeze({
  binding: 'left',
  firstFace: 'outside',
  rotation: 0,
  backFlipped: false,
  quarterTurn: 0,
  reverseSheets: false,
});

/**
 * スキャン 1 枚（PDF の 1 ページ）を左右に分割したとき、それぞれが何ページ目になるか。
 *
 * @param {number} scanCount スキャン PDF のページ数
 * @param {Options} opts
 * @returns {{ totalPages: number, sheets: number,
 *            scans: { rotation: number, pages: [number, number] }[] }}
 *   scans[i].rotation: そのスキャンを読める向きにするための時計回りの回転角
 *   scans[i].pages:    読める向きにしたときの [左半分, 右半分] のページ番号（1 始まり）
 */
export function computeLayout(scanCount, opts) {
  const sheets = Math.ceil(scanCount / 2);
  const totalPages = sheets * 4;

  // 外側を上にして広げると一番外の紙が一番上、内側を上にすると一番内側の紙が一番上に来る。
  const innerFirst = (opts.firstFace === 'inside') !== opts.reverseSheets;

  const scans = [];
  for (let i = 0; i < scanCount; i++) {
    const seq = Math.floor(i / 2);
    const isBack = i % 2 === 1;
    const k = innerFirst ? sheets - 1 - seq : seq; // 0 = 一番外側の紙
    const outside = (opts.firstFace === 'outside') !== isBack;

    // 左とじで広げたときの並び（左, 右）
    let pages = outside
      ? [totalPages - 2 * k, 2 * k + 1]
      : [2 * k + 2, totalPages - 2 * k - 1];
    if (opts.binding === 'right') pages = [pages[1], pages[0]];

    let rotation = opts.rotation + opts.quarterTurn;
    if (isBack && opts.backFlipped) rotation += 180;

    scans.push({ rotation: rotation % 360, pages });
  }
  return { totalPages, sheets, scans };
}

/**
 * ページ番号順の一覧に並べ替える。スキャンが奇数枚の場合などで存在しないページは null。
 * @returns {({ scan: number, half: 0|1, rotation: number } | null)[]}
 */
export function pageOrder(layout) {
  const order = new Array(layout.totalPages).fill(null);
  layout.scans.forEach((s, scan) => {
    s.pages.forEach((p, half) => {
      order[p - 1] = { scan, half, rotation: s.rotation };
    });
  });
  return order;
}
