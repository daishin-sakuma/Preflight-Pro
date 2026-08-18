// Rule engine: converts raw analysis into user-facing findings,
// evaluated against the selected print settings.

import type { AnalysisResult, Finding, Settings, Severity } from './types.ts';
import { MM_PER_PT } from './types.ts';
import { paperSizeMm } from './presets.ts';

const f = (
  id: string, category: Finding['category'], severity: Severity,
  title: string, detail: string, extra?: Partial<Finding>,
): Finding => ({ id, category, severity, title, detail, ...extra });

const fmt = (n: number, d = 1) => Number(n.toFixed(d)).toLocaleString('ja-JP');

export function runChecks(a: AnalysisResult, s: Settings): Finding[] {
  const out: Finding[] = [];
  const paper = paperSizeMm(s.paperId, s.customWmm, s.customHmm, s.landscape);

  // marker helpers: link findings to locatable spots on the 2D preview
  const mk = (kind: NonNullable<Finding['markerKind']>) =>
    a.markers?.some((m) => m.kind === kind) ? kind : undefined;
  const mkPages = (kind: string) =>
    [...new Set((a.markers ?? []).filter((m) => m.kind === kind).map((m) => m.page))].sort((x, y) => x - y);

  // =====================================================================
  // 1. 塗り足し・仕上がりサイズ
  // =====================================================================
  if (a.kind === 'pdf') {
    const pg = a.pages[0];
    if (pg) {
      const media = pg.mediaBoxPt;
      const mediaW = (media[2] - media[0]) * MM_PER_PT;
      const mediaH = (media[3] - media[1]) * MM_PER_PT;

      if (pg.trimBoxPt) {
        const t = pg.trimBoxPt;
        const trimW = (t[2] - t[0]) * MM_PER_PT;
        const trimH = (t[3] - t[1]) * MM_PER_PT;
        // trim vs ordered size
        const okSize =
          (Math.abs(trimW - paper.wMm) < 1 && Math.abs(trimH - paper.hMm) < 1) ||
          (Math.abs(trimW - paper.hMm) < 1 && Math.abs(trimH - paper.wMm) < 1);
        out.push(okSize
          ? f('trim-size', 'bleed', 'ok', '仕上がりサイズ一致',
            `TrimBox ${fmt(trimW)}×${fmt(trimH)}mm が指定サイズ (${paper.wMm}×${paper.hMm}mm) と一致しています。`)
          : f('trim-size', 'bleed', 'error', '仕上がりサイズ不一致',
            `TrimBox は ${fmt(trimW)}×${fmt(trimH)}mm ですが、指定サイズは ${paper.wMm}×${paper.hMm}mm です。原寸で作成し直すか、注文サイズを確認してください。`));

        // bleed = media (or bleedbox) beyond trim
        const outer = pg.bleedBoxPt ?? media;
        const bl = Math.min(
          (t[0] - outer[0]), (outer[2] - t[2]),
          (t[1] - outer[1]), (outer[3] - t[3]),
        ) * MM_PER_PT;
        if (bl >= s.bleedMm - 0.3) {
          out.push(f('bleed', 'bleed', 'ok', '塗り足しあり',
            `塗り足し幅 約${fmt(bl)}mm が確保されています (必要: ${s.bleedMm}mm)。`));
        } else if (bl > 0.3) {
          out.push(f('bleed', 'bleed', 'warning', '塗り足し不足',
            `塗り足し幅が約${fmt(bl)}mm しかありません (必要: ${s.bleedMm}mm)。断裁時に紙白が出る恐れがあります。`));
        } else {
          out.push(f('bleed', 'bleed', 'error', '塗り足しなし',
            `仕上がり線の外側に塗り足しがありません。断裁ズレで紙白が出ます。周囲${s.bleedMm}mmまで絵柄を伸ばしてください。`));
        }
      } else {
        // No TrimBox: compare media to ordered size
        const plain =
          (Math.abs(mediaW - paper.wMm) < 1 && Math.abs(mediaH - paper.hMm) < 1) ||
          (Math.abs(mediaW - paper.hMm) < 1 && Math.abs(mediaH - paper.wMm) < 1);
        const withBleed =
          (Math.abs(mediaW - (paper.wMm + s.bleedMm * 2)) < 1 && Math.abs(mediaH - (paper.hMm + s.bleedMm * 2)) < 1) ||
          (Math.abs(mediaW - (paper.hMm + s.bleedMm * 2)) < 1 && Math.abs(mediaH - (paper.wMm + s.bleedMm * 2)) < 1);
        if (withBleed) {
          out.push(f('trim-missing', 'bleed', 'info', 'TrimBox未設定 (塗り足し込みサイズ)',
            `ページサイズ ${fmt(mediaW)}×${fmt(mediaH)}mm は仕上がり+塗り足し${s.bleedMm}mmに一致します。TrimBox(仕上がり線)は未設定のため、印刷所側でセンター断裁として扱われます。`));
        } else if (plain) {
          out.push(f('trim-missing', 'bleed', 'error', '塗り足しなし (原寸ジャスト)',
            `ページサイズが仕上がり原寸 (${fmt(mediaW)}×${fmt(mediaH)}mm) ちょうどで、塗り足しがありません。周囲${s.bleedMm}mmの塗り足しを付けてください。`));
        } else {
          out.push(f('trim-missing', 'bleed', 'warning', 'サイズ確認が必要',
            `ページサイズ ${fmt(mediaW)}×${fmt(mediaH)}mm が指定サイズ (${paper.wMm}×${paper.hMm}mm / 塗り足し込み ${paper.wMm + s.bleedMm * 2}×${paper.hMm + s.bleedMm * 2}mm) と一致しません。トンボ付きの場合はTrimBoxの設定を推奨します。`));
        }
      }
    }

    // page size consistency
    if (a.pages.length > 1) {
      const w0 = a.pages[0].widthPt, h0 = a.pages[0].heightPt;
      const mixed = a.pages.some((p) => Math.abs(p.widthPt - w0) > 1 || Math.abs(p.heightPt - h0) > 1);
      if (mixed) {
        out.push(f('page-size-mixed', 'bleed', 'warning', 'ページサイズ混在',
          '文書内でページサイズが混在しています。全ページ同一サイズでの入稿が原則です。'));
      }
    }
  } else if (a.imageInfo) {
    // raster submission: does pixel size cover trim + bleed at min dpi?
    const info = a.imageInfo;
    const needW = paper.wMm + s.bleedMm * 2;
    const needH = paper.hMm + s.bleedMm * 2;
    const dpiW = info.width / (needW / 25.4);
    const dpiH = info.height / (needH / 25.4);
    const effDpi = Math.min(dpiW, dpiH);
    const dpiTrim = Math.min(
      info.width / (paper.wMm / 25.4),
      info.height / (paper.hMm / 25.4),
    );
    if (effDpi >= s.minDpi) {
      out.push(f('img-bleed', 'bleed', 'ok', '塗り足し込みサイズOK',
        `塗り足し${s.bleedMm}mm込み (${fmt(needW)}×${fmt(needH)}mm) に対して実効${Math.round(effDpi)}dpiを確保できています。画像の外周${s.bleedMm}mmは断ち落とされる前提でレイアウトしてください。`));
    } else if (dpiTrim >= s.minDpi) {
      out.push(f('img-bleed', 'bleed', 'warning', '塗り足し分の余裕なし',
        `仕上がり原寸では${Math.round(dpiTrim)}dpiありますが、塗り足し${s.bleedMm}mmを含めると${Math.round(effDpi)}dpiに低下します。塗り足し込みでの作成を推奨します。`));
    } else {
      out.push(f('img-bleed', 'bleed', 'error', 'サイズ (解像度) 不足',
        `${paper.wMm}×${paper.hMm}mm+塗り足しには ${Math.ceil((needW / 25.4) * s.minDpi)}×${Math.ceil((needH / 25.4) * s.minDpi)}px 必要ですが、${info.width}×${info.height}px しかありません (実効${Math.round(effDpi)}dpi)。`));
    }
  }

  // =====================================================================
  // 2. カラーモード
  // =====================================================================
  if (a.kind === 'pdf' && a.scan && a.content) {
    const rgbHit = a.scan.hasDeviceRGB || a.scan.hasCalRGB || a.content.rgbOps > 0;
    if (rgbHit) {
      const sev: Severity = s.requireCmyk ? 'error' : 'warning';
      const srcs: string[] = [];
      if (a.content.rgbOps > 0) srcs.push(`RGB指定の描画 ${a.content.rgbOps}箇所`);
      if (a.scan.hasDeviceRGB) srcs.push('DeviceRGB色空間');
      if (a.scan.hasCalRGB) srcs.push('CalRGB色空間');
      out.push(f('rgb', 'color', sev, 'RGBカラーが含まれています',
        `${srcs.join('、')} を検出しました。印刷はCMYKで行われるため、RGBのままでは印刷所側の自動変換で色味が大きく変わる恐れがあります。CMYKに変換して再入稿してください。`,
        { markerKind: mk('rgb'), pages: mkPages('rgb').length ? mkPages('rgb') : undefined }));
    } else if (a.scan.hasDeviceCMYK || a.scan.iccCmykLikely || a.content.cmykFills.length > 0) {
      const icc = a.scan.iccCmykLikely ? ' (ICCベースCMYK色空間)' : '';
      out.push(f('rgb', 'color', 'ok', 'CMYKカラーで作成されています',
        `RGBオブジェクトは検出されませんでした${icc}。`));
    } else {
      out.push(f('rgb', 'color', 'info', 'カラー使用なし/判定不能',
        'カラー指定オブジェクトが検出できませんでした (グレースケールのみ、または特殊な色空間・グラデーションのみで構成されている可能性)。'));
    }

    if (a.scan.hasICCBased && a.scan.iccRgbLikely && s.requireCmyk) {
      out.push(f('icc-rgb', 'color', 'warning', 'ICCベースのRGB色空間の可能性',
        'ICCプロファイル参照色空間 (RGB系) が含まれている可能性があります。埋め込み画像がRGBのままになっていないかご確認ください。'));
    }

    if (a.scan.separationNames.length > 0) {
      out.push(f('spot', 'color', 'warning', '特色 (スポットカラー) 使用',
        `特色「${a.scan.separationNames.slice(0, 6).join('」「')}」が定義されています。通常の4色 (CMYK) 印刷では特色は使用できません。プロセスカラーに変換してください (特色印刷を注文している場合は問題ありません)。`,
        { count: a.scan.separationNames.length }));
    }

    if (a.scan.pdfxVersion) {
      out.push(f('pdfx', 'color', 'ok', `PDF/X準拠 (${a.scan.pdfxVersion})`,
        `出力インテント: ${a.scan.outputIntent ?? '記載なし'}。印刷用途に適した規格で保存されています。`));
    }
  } else if (a.imageInfo) {
    const info = a.imageInfo;
    if (info.colorSpace === 'rgb' || info.colorSpace === 'palette') {
      const sev: Severity = s.requireCmyk ? 'warning' : 'info';
      out.push(f('img-rgb', 'color', sev,
        info.format === 'png' ? 'PNGはRGB形式です' : 'RGB形式の画像です',
        `この画像はRGB${info.colorSpace === 'palette' ? ' (インデックスカラー)' : ''}です。印刷所でCMYK変換されるため、鮮やかなRGB色 (蛍光色系) はくすんで印刷されます。厳密な色管理が必要な場合はCMYKのPDF/TIFF等での入稿を推奨します。`));
    } else if (info.colorSpace === 'cmyk') {
      out.push(f('img-rgb', 'color', 'ok', 'CMYK形式の画像です',
        'CMYK JPEGを検出しました。ブラウザプレビューは近似表示となります。'));
    } else if (info.colorSpace === 'gray') {
      out.push(f('img-rgb', 'color', 'info', 'グレースケール画像です',
        'モノクロ印刷用であれば問題ありません。'));
    }
    if (info.hasIccProfile) {
      out.push(f('img-icc', 'color', 'info', 'ICCプロファイル埋め込みあり',
        `${info.iccName ? `プロファイル: ${info.iccName}。` : ''}印刷所の運用によっては破棄されます。Japan Color 2001 Coated 相当での作成が一般的です。`));
    }
    if (info.hasAlpha) {
      out.push(f('img-alpha', 'color', 'warning', '透明 (アルファチャンネル) あり',
        '透明部分は印刷時に白または不定な色になります。背景を敷いて統合してください。'));
    }
  }

  // =====================================================================
  // 3. インキ (TAC / ベタ / オーバープリント)
  // =====================================================================
  if (a.kind === 'pdf' && a.content && a.scan) {
    const over = a.content.cmykFills.filter((c) => c.tac > s.tacLimit);
    const reg4 = a.content.cmykFills.filter((c) => c.c >= 0.99 && c.m >= 0.99 && c.y >= 0.99 && c.k >= 0.99);
    const heavy3 = a.content.cmykFills.filter(
      (c) => c.tac <= s.tacLimit && [c.c, c.m, c.y].filter((v) => v >= 0.9).length >= 3,
    );

    if (reg4.length > 0 || a.scan.usesRegistrationAll) {
      out.push(f('4c-black', 'ink', 'error', '4色ベタ (C100 M100 Y100 K100)',
        `4色ベタ${a.scan.usesRegistrationAll ? '・レジストレーションカラー (トンボ用の特殊色)' : ''}が使われています。インキが乾かず裏移り・ブロッキングの原因になります。黒はK100%または適正なリッチブラック (例: C40 M30 Y30 K100) に修正してください。`));
    }
    if (over.length > 0) {
      const worst = over.reduce((x, y) => (x.tac > y.tac ? x : y));
      out.push(f('tac-vector', 'ink', 'error', `総インキ量 ${s.tacLimit}% 超過`,
        `上限${s.tacLimit}%を超えるカラー指定が${over.length}色あります (最大 ${Math.round(worst.tac)}%: C${Math.round(worst.c * 100)} M${Math.round(worst.m * 100)} Y${Math.round(worst.y * 100)} K${Math.round(worst.k * 100)})。乾燥不良・裏移りの原因になるため、合計${s.tacLimit}%以下に調整してください。`,
        { count: over.length, markerKind: mk('tac'), pages: mkPages('tac').length ? mkPages('tac') : undefined }));
    } else if (a.content.cmykFills.length > 0 && reg4.length === 0) {
      out.push(f('tac-vector', 'ink', 'ok', `総インキ量 (ベクター) ${s.tacLimit}%以内`,
        `検出したCMYK指定 ${a.content.cmykFills.length}色 はすべて上限内です。`));
    }
    if (heavy3.length > 0) {
      out.push(f('3c-heavy', 'ink', 'warning', '3色高濃度ベタ',
        `CMY3色とも90%以上の高濃度指定が${heavy3.length}色あります。見当ズレや乾燥不良のリスクがあります。K版を活用した設計を推奨します。`,
        { count: heavy3.length }));
    }
    if (a.content.richBlackText.length > 0) {
      out.push(f('rich-black-text', 'ink', 'warning', '文字へのリッチブラック使用',
        `テキストに3色以上を重ねた黒 (リッチブラック) が使われています。小さな文字では版ズレで輪郭がにじみます。スミ文字はK100%単色を推奨します。`,
        { count: a.content.richBlackText.length, markerKind: mk('rich-black') }));
    }

    // pixel-based approximate TAC (photos etc.)
    const worstTac = a.tac.reduce((mx, t) => Math.max(mx, t.maxTac), 0);
    const anyOver = a.tac.some((t) => t.overLimitRatio > 0.0005);
    if (anyOver) {
      out.push(f('tac-raster', 'ink', 'warning', '高インキ量領域あり (参考値)',
        `レンダリング結果からの推定で、総インキ量が${s.tacLimit}%を超える可能性のある領域を検出しました (推定最大 約${worstTac}%)。プレビューの「インキ量」表示で位置を確認できます。※RGB描画からの近似のため、正確な値は元データのCMYK値をご確認ください。`,
        { pages: a.tac.filter((t) => t.overLimitRatio > 0.0005).map((t) => t.page) }));
    }

    // overprint
    if (a.content.whiteFillWithGs > 0) {
      out.push(f('white-op', 'ink', 'error', '白オブジェクトのオーバープリント (白ノセ) の疑い',
        `オーバープリント設定が有効な文書内で、白い塗りオブジェクトを${a.content.whiteFillWithGs}件検出しました。白にノセが設定されていると、その部分は印刷時に消えます (画面では見えるため事故が多発するポイントです)。オーバープリントを解除してください。`,
        { markerKind: mk('white-op'), pages: mkPages('white-op').length ? mkPages('white-op') : undefined }));
    }
    if (a.scan.overprintTrue) {
      const opCount = (a.markers ?? []).filter((m) => m.kind === 'overprint').length;
      out.push(f('overprint', 'ink', 'warning', 'オーバープリント (ノセ) 設定あり',
        'オーバープリント指定が含まれています。意図したノセ (K100文字のノセ等) であれば問題ありませんが、意図しない場合は「オーバープリントプレビュー」で確認してください。印刷所によっては自動でK100のみノセ処理されます。',
        {
          count: opCount || undefined,
          markerKind: mk('overprint'),
          pages: mkPages('overprint').length ? mkPages('overprint') : undefined,
        }));
    } else if (a.content.whiteFillWithGs === 0) {
      out.push(f('overprint', 'ink', 'ok', 'オーバープリント設定なし',
        '危険なオーバープリント指定は検出されませんでした (K100文字は印刷所側で自動ノセ処理されるのが一般的です)。'));
    }
  } else if (a.imageInfo) {
    const worstTac = a.tac.reduce((mx, t) => Math.max(mx, t.maxTac), 0);
    const anyOver = a.tac.some((t) => t.overLimitRatio > 0.0005);
    out.push(anyOver
      ? f('tac-raster', 'ink', 'warning', '高インキ量領域あり (参考値)',
        `CMYK変換後に総インキ量${s.tacLimit}%を超える可能性がある濃い領域を検出しました (推定最大 約${worstTac}%)。プレビューの「インキ量」表示で確認してください。`)
      : f('tac-raster', 'ink', 'ok', `総インキ量 ${s.tacLimit}%以内 (推定)`,
        `CMYK変換後の総インキ量は上限内に収まる見込みです (推定最大 約${worstTac}%)。`));
  }

  // =====================================================================
  // 4. 解像度
  // =====================================================================
  if (a.kind === 'pdf') {
    if (a.images.length > 0) {
      const low = a.images.filter((im) => im.effectiveDpi < s.minDpi && im.printWidthMm > 5 && im.printHeightMm > 5);
      const veryLow = low.filter((im) => im.effectiveDpi < Math.min(200, s.minDpi));
      if (low.length === 0) {
        out.push(f('dpi', 'resolution', 'ok', `配置画像はすべて${s.minDpi}dpi以上`,
          `${a.images.length}枚の配置画像の実効解像度を確認しました。`));
      } else {
        const worst = low.reduce((x, y) => (x.effectiveDpi < y.effectiveDpi ? x : y));
        out.push(f('dpi', 'resolution', veryLow.length > 0 ? 'error' : 'warning',
          `低解像度の配置画像 ${low.length}枚`,
          `実効${s.minDpi}dpi未満の画像があります (最低 ${worst.effectiveDpi}dpi、配置サイズ ${fmt(worst.printWidthMm, 0)}×${fmt(worst.printHeightMm, 0)}mm)。粗く印刷されます。原寸で${s.minDpi}dpi以上の画像に差し替えるか、配置サイズを縮小してください。`,
          { count: low.length, pages: [...new Set(low.map((i) => i.page))] }));
      }
    } else {
      out.push(f('dpi', 'resolution', 'info', '配置画像なし',
        'ラスター画像は検出されませんでした (ベクターのみ)。'));
    }
  } else if (a.imageInfo) {
    const info = a.imageInfo;
    if (info.embeddedDpi) {
      out.push(f('img-dpi-meta', 'resolution', 'info', `画像の解像度設定: ${info.embeddedDpi}dpi`,
        `メタデータ上の解像度です。実際の印刷品質は「指定サイズに対する実効解像度」(塗り足しチェック参照) で決まります。`));
    }
  }

  // =====================================================================
  // 5. フォント
  // =====================================================================
  if (a.kind === 'pdf' && a.scan) {
    if (a.scan.fontsTotal === 0) {
      out.push(f('fonts', 'font', 'ok', 'フォント使用なし',
        'フォントは検出されませんでした (アウトライン化済み、または画像化されています)。'));
    } else if (a.scan.fontsNotEmbedded.length === 0) {
      out.push(f('fonts', 'font', 'ok', `全フォント埋め込み済み (${a.scan.fontsTotal}書体)`,
        'すべてのフォントがPDFに埋め込まれています。'));
    } else {
      out.push(f('fonts', 'font', 'error', 'フォント未埋め込み',
        `埋め込まれていないフォントがあります: ${a.scan.fontsNotEmbedded.slice(0, 5).join(', ')}${a.scan.fontsNotEmbedded.length > 5 ? ' 他' : ''}。印刷所の環境で文字化け・別書体に置き換わります。フォントを埋め込むかアウトライン化してください。`,
        { count: a.scan.fontsNotEmbedded.length, markerKind: mk('font'), pages: mkPages('font').length ? mkPages('font') : undefined }));
    }
  }

  // =====================================================================
  // 6. その他
  // =====================================================================
  if (a.kind === 'pdf' && a.scan && a.content) {
    if (a.scan.encrypted) {
      out.push(f('encrypted', 'other', 'error', 'セキュリティ (暗号化) 設定あり',
        'パスワード・編集制限付きのPDFは印刷所で処理できません。セキュリティなしで書き出してください。'));
    }
    if (a.scan.transparencyUsed) {
      out.push(f('transparency', 'other', 'info', '透明効果の使用',
        'ドロップシャドウ等の透明効果が使われています。多くの印刷所はPDF/X-1a運用時に透明を分割統合します。まれに白い線 (分割痕) がプレビューに見えることがありますが、通常は印刷されません。心配な場合はPDF/X-4での入稿可否を印刷所に確認してください。'));
    }
    if (a.scan.hasAnnotsOrForms) {
      out.push(f('annots', 'other', 'warning', '注釈・フォームフィールドあり',
        'PDF注釈やフォームは印刷されない、または意図せず印刷される場合があります。統合または削除してください。'));
    }
    if (a.scan.hasLayers) {
      out.push(f('layers', 'other', 'info', 'レイヤー (OCG) あり',
        '非表示レイヤーが含まれる場合、印刷所のRIPで意図しない出力になることがあります。レイヤーを統合しての書き出しを推奨します。'));
    }
    if (a.content.hairlineCount > 0) {
      out.push(f('hairline', 'other', 'warning', '極細線 (ヘアライン)',
        `線幅0.25pt未満の罫線を${a.content.hairlineCount}箇所検出しました。印刷で消える・かすれる恐れがあります。0.25pt (約0.09mm) 以上にしてください。`,
        { count: a.content.hairlineCount, markerKind: mk('hairline') }));
    }
    if (a.scan.pdfVersion) {
      const v = parseFloat(a.scan.pdfVersion);
      out.push(f('pdf-version', 'other', v >= 1.3 ? 'info' : 'warning',
        `PDFバージョン: ${a.scan.pdfVersion}`,
        v >= 1.3 ? '一般的な印刷ワークフローで対応可能なバージョンです。'
          : '非常に古いPDFバージョンです。再書き出しを推奨します。'));
    }
  }

  for (const n of a.notes) {
    out.push(f(`note-${out.length}`, 'other', 'info', '解析メモ', n));
  }

  return out;
}
