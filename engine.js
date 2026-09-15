/* =========================================================================
   engine.js — 사진 인식 판정 엔진, 한 벌 (외계인 찾기)

   2026-08-31 통합에서 추출. 원본: M1(외계인찾기_M1_매칭엔진.html)을 M2·M5가
   복제해 쓰다가 세 벌로 갈라지던 것을(버그점검 5번) 이 파일 하나로 통일했다.
   구조·판정 계약은 모듈1_사진인식_구조.md 0~2장 그대로.

   사용법:
     <script src="api.js"></script>
     <script src="engine.js"></script>
     ENGINE.init(await API.getConfig());          // 임계값은 CONFIG 한 곳 (원칙 6)
     ENGINE.loadOpenCv(onReady, onFail);          // CDN 3단 예비
     ... ENGINE.judgeAttempt(bank, file, opts) ...

   임계값을 코드에 두지 않는다 — 전부 CONFIG.engine.* 에서 읽는다.
   ========================================================================= */

const ENGINE = (() => {
  'use strict';
  let C = null;                 // API.getConfig() 결과

  /* cv.Mat은 GC가 안 된다 — 판정 1회 단위로 전량 해제 */
  class MatPool {
    constructor() { this._i = []; }
    track(o) { this._i.push(o); return o; }
    releaseAll() { for (const x of this._i) { try { x.delete(); } catch (_) {} } this._i.length = 0; }
  }

  const Pipeline = {
    async fileToCanvas(file) {
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (_) { bmp = await createImageBitmap(file); }
      const s = Math.min(1, C.engine.image.maxDim / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
      return c;
    },
    async dataUrlToCanvas(dataUrl) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const s = Math.min(1, C.engine.image.maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    },

    /* 흑백 + 이중 선명도(CLAHE 이전 측정 — 순서 중요) + CLAHE */
    normalize(pool, canvas) {
      const src = pool.track(cv.imread(canvas));
      const gray = pool.track(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const lap = pool.track(new cv.Mat());
      cv.Laplacian(gray, lap, cv.CV_64F);
      const m1 = pool.track(new cv.Mat()), s1 = pool.track(new cv.Mat());
      cv.meanStdDev(lap, m1, s1);
      const lapVar = s1.data64F[0] ** 2;
      const m2 = pool.track(new cv.Mat()), s2 = pool.track(new cv.Mat());
      cv.meanStdDev(gray, m2, s2);
      const sharpness = Math.round(lapVar * 10) / 10;
      const sharpnessNorm = Math.round(lapVar / Math.max(s2.data64F[0] ** 2, 1e-6) * 100 * 100) / 100;
      const eq = pool.track(new cv.Mat());
      pool.track(new cv.CLAHE(C.engine.image.claheClip,
        new cv.Size(C.engine.image.claheGrid, C.engine.image.claheGrid))).apply(gray, eq);
      return { mat: eq, sharpness, sharpnessNorm };
    },

    /* 이중 선명도 게이트 — 둘 중 하나만 통과하면 선명 (조도 실측 2026.8.19) */
    isSharp(norm) {
      return norm.sharpness >= C.engine.judge.minSharpness
          || norm.sharpnessNorm >= C.engine.judge.minSharpnessNorm;
    },

    _orb(pool, n) {
      const o = C.engine.orb;
      try { return pool.track(new cv.ORB(n || o.nFeatures, o.scaleFactor, o.nLevels)); }
      catch (_) { try { return pool.track(new cv.ORB(n || o.nFeatures)); }
      catch (_) { return pool.track(new cv.ORB()); } }
    },

    extract(pool, gray, n) {
      const kp = pool.track(new cv.KeyPointVector());
      const desc = pool.track(new cv.Mat());
      this._orb(pool, n).detectAndCompute(gray, pool.track(new cv.Mat()), kp, desc);
      return { keypoints: kp, descriptors: desc, count: kp.size() };
    },

    /* 특징점 분포 변동계수 — 노이즈·반복무늬 검출 (M5 실측: 노이즈 0.27~0.35 vs 실제 0.85~3.15) */
    spread(feat, w, h) {
      const grid = new Array(36).fill(0);
      for (let i = 0; i < feat.count; i++) {
        const p = feat.keypoints.get(i).pt;
        grid[Math.min(5, Math.floor(p.y / h * 6)) * 6 + Math.min(5, Math.floor(p.x / w * 6))]++;
      }
      const mean = grid.reduce((a, b) => a + b, 0) / 36;
      if (mean < 1e-6) return 0;
      const sd = Math.sqrt(grid.reduce((a, b) => a + (b - mean) ** 2, 0) / 36);
      return Math.round(sd / mean * 1000) / 1000;
    },

    /* 자기 유사성(반복 무늬): 좌/우 반쪽 상호 매칭률 % (M5 실측: 정상 0~0.4 vs 반복 4.1~8.4) */
    selfSimilarity(pool, gray) {
      const w = gray.cols, h = gray.rows, half = C.engine.selfSim.halfFeatures;
      const L = pool.track(gray.roi(new cv.Rect(0, 0, Math.floor(w / 2), h)));
      const R = pool.track(gray.roi(new cv.Rect(Math.floor(w / 2), 0, Math.floor(w / 2), h)));
      const fl = this.extract(pool, L, half), fr = this.extract(pool, R, half);
      if (fl.count < C.engine.selfSim.minKeypoints || fr.count < C.engine.selfSim.minKeypoints) return 0;
      const bf = pool.track(new cv.BFMatcher(cv.NORM_HAMMING, false));
      const knn = pool.track(new cv.DMatchVectorVector());
      bf.knnMatch(fl.descriptors, fr.descriptors, knn, 2);
      let good = 0;
      for (let i = 0; i < knn.size(); i++) {
        const p = knn.get(i);
        if (p.size() >= 2 && p.get(0).distance < C.engine.match.loweRatio * p.get(1).distance) good++;
        try { p.delete(); } catch (_) {}
      }
      return Math.round(good / Math.min(fl.count, fr.count) * 1000) / 10;
    },
  };

  const Matcher = {
    compare(pool, bankFeat, tryFeat, refSize) {
      if (bankFeat.descriptors.rows < 2 || tryFeat.descriptors.rows < 2)
        return { good: 0, inliers: 0, viewShift: null };
      const bf = pool.track(new cv.BFMatcher(cv.NORM_HAMMING, false));
      const knn = pool.track(new cv.DMatchVectorVector());
      bf.knnMatch(bankFeat.descriptors, tryFeat.descriptors, knn, 2);
      const good = [];
      for (let i = 0; i < knn.size(); i++) {
        const p = knn.get(i);
        if (p.size() >= 2) {
          const m = p.get(0), n = p.get(1);
          if (m.distance < C.engine.match.loweRatio * n.distance) good.push(m);
        }
        try { p.delete(); } catch (_) {}
      }
      if (good.length < C.engine.match.minGoodPairs)
        return { good: good.length, inliers: 0, viewShift: null };
      const sf = [], df = [];
      for (const m of good) {
        const a = bankFeat.keypoints.get(m.queryIdx).pt, b = tryFeat.keypoints.get(m.trainIdx).pt;
        sf.push(a.x, a.y); df.push(b.x, b.y);
      }
      const sm = pool.track(cv.matFromArray(good.length, 1, cv.CV_32FC2, sf));
      const dm = pool.track(cv.matFromArray(good.length, 1, cv.CV_32FC2, df));
      const mask = pool.track(new cv.Mat());
      const H = pool.track(cv.findHomography(sm, dm, cv.RANSAC, C.engine.ransac.reprojThreshold, mask));
      if (H.empty()) return { good: good.length, inliers: 0, viewShift: null };
      let inl = 0;
      for (let i = 0; i < good.length; i++) if (mask.data[i]) inl++;
      return { good: good.length, inliers: inl, viewShift: this._shift(pool, H, refSize.w, refSize.h) };
    },
    _shift(pool, H, w, h) {
      const c = pool.track(cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, w,0, w,h, 0,h]));
      const o = pool.track(new cv.Mat());
      cv.perspectiveTransform(c, o, H);
      const p = []; for (let i = 0; i < 4; i++) p.push({ x: o.data32F[i*2], y: o.data32F[i*2+1] });
      const d = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
      const L=d(p[3],p[0]), R=d(p[2],p[1]), T=d(p[1],p[0]), B=d(p[2],p[3]);
      if (!L||!R||!T||!B) return 100;
      return Math.round(Math.max(Math.abs(L-R)/Math.max(L,R), Math.abs(T-B)/Math.max(T,B)) * 1000) / 10;
    },
  };

  const Judge = {
    /* 계약 (모듈1 문서 0장): verdictKey pass/part/near/fail/void + score + best */
    evaluate(results, tryCount, sharpOk, viewShiftTolPct) {
      if (!sharpOk || tryCount < C.engine.judge.minFeatures)
        return { verdictKey: 'void', score: 0, best: null };
      let best = null;
      for (const r of results) if (!best || r.inliers > best.inliers) best = r;
      if (!best || best.inliers === 0) return { verdictKey: 'fail', score: 0, best };
      const minI = C.minInliers, fullI = C.engine.judge.fullInliers;
      let base;
      if (best.inliers >= fullI) base = 100;
      else if (best.inliers >= minI) base = 60 + 40 * (best.inliers - minI) / (fullI - minI);
      else base = 60 * best.inliers / minI;
      const tol = viewShiftTolPct ?? C.viewShiftTol.normal;
      const over = best.viewShift === null ? 100 : Math.max(0, best.viewShift - tol);
      const score = Math.max(0, Math.min(100, Math.round(base - over * C.engine.judge.anglePenaltyPerPct)));
      const V = C.verdict;
      const key = score >= V.full ? 'pass' : score >= V.partial ? 'part' : score >= V.near ? 'near' : 'fail';
      return { verdictKey: key, score, best };
    },
  };

  const Gps = {
    distanceM(a, b) {
      const R = 6371000, rad = d => d * Math.PI / 180;
      const dLa = rad(b.lat - a.lat), dLo = rad((b.lng ?? b.lon) - (a.lng ?? a.lon));
      const s = Math.sin(dLa/2)**2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo/2)**2;
      return Math.round(2 * R * Math.asin(Math.sqrt(s)));
    },
    /* 절대 마감시간 포함 — 권한 '묻기' 상태의 무한 대기 방지 (버그점검 2026.8.19 11번) */
    current(deadlineMs = 6000) {
      return Promise.race([
        new Promise((res, rej) => {
          if (!navigator.geolocation) return rej(new Error('geolocation 미지원'));
          navigator.geolocation.getCurrentPosition(
            p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
            e => rej(e), { enableHighAccuracy: true, timeout: deadlineMs - 2000 });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('위치 응답 시간 초과')), deadlineMs)),
      ]);
    },
  };

  /* 출제 사전 검사 4종 (M5 계약). onStep(n, 'run'|'ok'|'no') 콜백으로 진행 표시.
     반환: { pass, failKey('sharp'|'feat'|'sim'), nums } */
  async function questChecks(canvas, onStep) {
    const pool = new MatPool();
    const t0 = performance.now();
    const step = onStep || (() => {});
    const frame = () => new Promise(r => setTimeout(r, 350));
    try {
      const q = C.quest;
      step(1, 'run');
      const norm = Pipeline.normalize(pool, canvas);
      await frame();
      if (norm.sharpness < q.minSharpness && norm.sharpnessNorm < q.minSharpnessNorm)
        return fin(1, 'sharp', { sharpness: norm.sharpness, sharpnessNorm: norm.sharpnessNorm });
      step(1, 'ok');
      step(2, 'run');
      const feat = Pipeline.extract(pool, norm.mat);
      const spread = Pipeline.spread(feat, norm.mat.cols, norm.mat.rows);
      await frame();
      if (feat.count < q.minFeatures || spread < q.minSpread)
        return fin(2, 'feat', { sharpness: norm.sharpness, sharpnessNorm: norm.sharpnessNorm,
                                features: feat.count, spread });
      step(2, 'ok');
      step(3, 'run');
      const sim = Pipeline.selfSimilarity(pool, norm.mat);
      await frame();
      if (sim > q.selfSimMax)
        return fin(3, 'sim', { sharpness: norm.sharpness, sharpnessNorm: norm.sharpnessNorm,
                               features: feat.count, spread, selfSim: sim });
      step(3, 'ok');
      return { pass: true, failKey: null,
               nums: { sharpness: norm.sharpness, sharpnessNorm: norm.sharpnessNorm,
                       features: feat.count, spread, selfSim: sim,
                       elapsed: Math.round(performance.now() - t0) } };
    } finally { pool.releaseAll(); }
    function fin(n, key, nums) {
      step(n, 'no');
      nums.elapsed = Math.round(performance.now() - t0);
      return { pass: false, failKey: key, nums };
    }
  }

  /* 정답 뱅크 만들기: 사진(canvas)에서 특징점 추출. 세션 동안 유지되는 자체 풀 사용.
     반환 { canvas, feat, pool, release() } — 화면 종료 시 release() 권장 */
  function buildBankItem(canvas) {
    const pool = new MatPool();
    const norm = Pipeline.normalize(pool, canvas);
    const feat = Pipeline.extract(pool, norm.mat);
    return { canvas, feat, sharpness: norm.sharpness, sharpnessNorm: norm.sharpnessNorm,
             pool, release: () => pool.releaseAll() };
  }

  /* 인증 판정 한 번: bankItems(buildBankItem 결과 배열) vs 촬영 파일.
     opts: { viewShiftTolPct, log(msg) } */
  async function judgeAttempt(bankItems, file, opts = {}) {
    const log = opts.log || (() => {});
    const pool = new MatPool();
    const t0 = performance.now();
    try {
      const canvas = await Pipeline.fileToCanvas(file);
      const norm = Pipeline.normalize(pool, canvas);
      log(`선명도 ${norm.sharpness} / 정규화 ${norm.sharpnessNorm}`);
      let out;
      if (!Pipeline.isSharp(norm)) {
        out = { verdictKey: 'void', score: 0, best: null };
      } else {
        const tryFeat = Pipeline.extract(pool, norm.mat);
        const results = [];
        for (let i = 0; i < bankItems.length; i++) {
          const b = bankItems[i];
          const r = Matcher.compare(pool, b.feat, tryFeat, { w: b.canvas.width, h: b.canvas.height });
          results.push(r);
          log(`뱅크#${i+1}: 후보 ${r.good} → 검증 ${r.inliers}, 시점차 ${r.viewShift ?? '-'}`);
          if (Judge.evaluate([r], tryFeat.count, true, opts.viewShiftTolPct).score
              >= C.engine.judge.earlyExitScore) break;
        }
        out = Judge.evaluate(results, tryFeat.count, true, opts.viewShiftTolPct);
      }
      out.sharpness = norm.sharpness;
      out.sharpnessNorm = norm.sharpnessNorm;
      out.tryCanvas = canvas;
      out.elapsed = Math.round(performance.now() - t0);
      log(`판정 ${out.verdictKey} ${out.score} (${out.elapsed}ms)`);
      return out;
    } finally { pool.releaseAll(); }
  }

  /* OpenCV.js 로딩 — CDN 3단 예비 */
  function loadOpenCv(onReady, onFail) {
    const SOURCES = [
      'https://docs.opencv.org/4.10.0/opencv.js',
      'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
      'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    ];
    let i = 0;
    const wait = () => {
      if (typeof cv === 'undefined') return fail();
      if (cv.getBuildInformation) return onReady();
      if (cv.then) { cv.then(onReady); return; }
      cv.onRuntimeInitialized = onReady;
    };
    const fail = () => onFail && onFail();
    const tryLoad = () => {
      if (i >= SOURCES.length) return fail();
      const s = document.createElement('script');
      s.src = SOURCES[i]; s.async = true;
      s.onload = wait; s.onerror = () => { i++; tryLoad(); };
      document.head.appendChild(s);
    };
    tryLoad();
  }

  return {
    init(config) { C = config; },
    get config() { return C; },
    MatPool, Pipeline, Matcher, Judge, Gps,
    questChecks, buildBankItem, judgeAttempt, loadOpenCv,
  };
})();

if (typeof module !== 'undefined') module.exports = ENGINE;
