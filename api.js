/* =========================================================================
   api.js — 데이터 단일 통로  (외계인 찾기 / 시스템_설계.md 5.5장 계약)

   v1.4 (2026-08-31, 중심 세션 — 통합 개정)
   - ME.solved를 [{questId, at}]로 개정, solvedByMe 계산을 api 안으로 (5.8 판정 2 이행)
   - CONFIG.engine 추가 — 판정 엔진의 모든 임계값을 CONFIG 한 곳으로 이관
     (버그점검 2026.8.19 "하드코딩 임계값" 항목 해소. engine.js가 이 값을 읽는다)
   - CONFIG.coupon.warnDays 3 추가 (5.8 추가판정 — M6 제안 7 채택)
   - invalidateCode 추가 (M6 내장본에 있던 것을 표준으로 승격 — 코드 화면 이탈 시 무효화)
   - 프로토타입 세션 다리(_bridge) 추가: 파일 분리 구조에서 화면 사이를 잇는
     sessionStorage 저장소. **서버 Attempt/DB의 프로토타입 대역**이며 서버가 생기면
     통째로 사라진다. 힌트 사용·새 출제·발견 기록·테마가 여기로 이어진다.
   - createQuest가 사진(dataURL)을 받아 지도·상세·인증에서 실제로 돌게 함
   - submitAttempt: 인증 성공 시 발견 기록(연출) — 도감이 한 바퀴 안에서 갱신된다

   v1.3.1 (2026-08-31) — quest.minSharpnessNorm 1.5 누락 보정
   v1.3 (2026-08-28) — hintPenalty·hintShrink·photo·쿠폰 3함수 (5.7·5.8 판정)
   v1.2 (2026-08-19) — createQuest·출제 검사 임계값
   v1.1 (2026-08-19) — 임계값 퍼센트 통일, 키 이름 엔진과 통일

   화면 코드는 절대 직접 fetch 하지 않는다. 반드시 이 객체를 통한다.
   서버 도입 시: 이 파일의 함수 본문만 fetch로 교체. 화면 코드는 불변.

   중요 — 개인정보 계약:
   getQuests() 반환 객체에 answer_gps(실제 촬영 위치)가 없다.
   center는 "실제 위치를 포함하는 임의 원의 중심"이다 (시스템_설계 1장).
   ========================================================================= */

const API = (() => {

  // ── 임계값: CONFIG 한 곳 (시스템_설계 원칙 6) ────────────────────────────
  const CONFIG = {
    minInliers: 30,
    viewShiftTol: { easy: 15, normal: 12, precise: 8 },
    verdict: { full: 90, partial: 70, near: 40 },
    map: { fadeFar: 1500, fadeNear: 150, defaultZoom: 15 },
    quest: { minSharpness: 40, minSharpnessNorm: 1.5, minFeatures: 400, selfSimMax: 2.0, minSpread: 0.5 },
    hintPenalty: { peek: 0.7, overlay: 0.5 },   // 둘 다 쓰면 큰 쪽 하나만 (5.7 판정 2)
    hintShrink: 0.5,
    coupon: { codeTtlSec: 180, warnSec: 30, warnDays: 3 },
    // 판정 엔진 파라미터 (통합 시 이관 — engine.js 전용. 값 출처는 기술검증_기록·모듈1 문서)
    engine: {
      image: { maxDim: 900, claheClip: 2.0, claheGrid: 8 },
      orb:   { nFeatures: 2000, scaleFactor: 1.2, nLevels: 8 },
      match: { loweRatio: 0.72, minGoodPairs: 10 },
      ransac:{ reprojThreshold: 4.0 },
      judge: { minSharpness: 40, minSharpnessNorm: 1.5, minFeatures: 100,
               fullInliers: 150, anglePenaltyPerPct: 2, earlyExitScore: 90 },
      gps:   { accuracyBufferM: 30 },
      bank:  { maxItems: 5 },
      selfSim: { halfFeatures: 1000, minKeypoints: 30 },
    },
  };

  // ── 프로토타입 세션 다리 ─────────────────────────────────────────────────
  // 서버 Attempt/DB의 대역. 화면(파일)을 오가도 한 탭 안에서는 상태가 이어진다.
  const BRIDGE_KEY = 'alien-proto-bridge';
  function _load() {
    try { return JSON.parse(sessionStorage.getItem(BRIDGE_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function _save(st) {
    try { sessionStorage.setItem(BRIDGE_KEY, JSON.stringify(st)); } catch (_) {}
  }

  // ── 시드 문제 (조치원 — 좌표는 근사값, 현장 촬영 후 교체) ────────────────
  const QUESTS = [
    { id:'q01', title:'역 앞 어딘가',        hint:'기둥 사이로 시계가 하나만 보이는 자리',
      center:{lat:36.6008, lng:127.2966}, radius:300, difficulty:'normal', status:'live',
      stats:{attempts:34, solves:11}, area:'조치원역' },
    { id:'q02', title:'셔터 내린 골목',      hint:'벽의 금이 간판 글씨처럼 보이는 곳',
      center:{lat:36.5996, lng:127.2938}, radius:300, difficulty:'precise', status:'live',
      stats:{attempts:52, solves:4},  area:'원도심 상가' },
    { id:'q03', title:'시장 뒷길',           hint:'파란 차양 아래, 두 건물이 겹쳐 한 줄이 되는 각도',
      center:{lat:36.5981, lng:127.2951}, radius:100, difficulty:'precise', status:'live',
      stats:{attempts:18, solves:2},  area:'조치원 전통시장' },
    { id:'q04', title:'언덕 위 계단',        hint:'계단 끝에서만 지붕 세 개가 나란히 선다',
      center:{lat:36.6106, lng:127.2897}, radius:500, difficulty:'easy',   status:'live',
      stats:{attempts:88, solves:41}, area:'고대 세종캠 주변' },
    { id:'q05', title:'담장의 틈',           hint:'틈 사이로 나무 한 그루가 정확히 들어온다',
      center:{lat:36.6131, lng:127.2925}, radius:300, difficulty:'normal', status:'live',
      stats:{attempts:27, solves:9},  area:'고대 세종캠 후문' },
    { id:'q06', title:'다리 아래',           hint:'물이 아니라 위를 봐야 한다',
      center:{lat:36.6047, lng:127.3012}, radius:300, difficulty:'normal', status:'live',
      stats:{attempts:15, solves:6},  area:'조천 산책로' },
    { id:'q07', title:'물길 굽는 자리',      hint:'난간 기둥이 하나로 포개지는 지점',
      center:{lat:36.6072, lng:127.3055}, radius:500, difficulty:'easy',   status:'review',
      stats:{attempts:3,  solves:1},  area:'조천 하류' },
    { id:'q08', title:'정수장 옆 벽',        hint:'페인트가 벗겨진 자리가 지도처럼 생겼다',
      center:{lat:36.5934, lng:127.3004}, radius:100, difficulty:'precise', status:'review',
      stats:{attempts:5,  solves:0},  area:'정수장 문화공원' },
    { id:'q09', title:'철길 옆 창고',        hint:'창문 두 개가 한 줄이 되는 곳에서 찍혔다',
      center:{lat:36.5959, lng:127.2999}, radius:300, difficulty:'normal', status:'live',
      stats:{attempts:22, solves:7},  area:'조치원역 남측' },
    { id:'q10', title:'오래된 표지판',       hint:'글씨는 지워졌는데 그림자는 남아 있다',
      center:{lat:36.6024, lng:127.2894}, radius:500, difficulty:'easy',   status:'dormant',
      stats:{attempts:41, solves:0},  area:'침산리 방면' },
  ];

  // 현재 사용자 — solved는 발견 시점을 갖는다 (5.8 판정 2, v1.4에서 이행)
  const ME = { id:'u_demo', grade:'normal', points:1240,
               solved:[ {questId:'q04', at:'지난주'}, {questId:'q06', at:'어제'} ], created:[] };

  const COUPONS = [
    { id:'c01', shop:'조치원 계단집', item:'국수 한 그릇 1,000원 할인', questId:'q04',
      status:'active', daysLeft:6, walk:'걸어서 3분' },
    { id:'c02', shop:'다리밑 커피',   item:'아메리카노 한 잔 무료',     questId:'q06',
      status:'active', daysLeft:2, walk:'걸어서 6분' },
    { id:'c03', shop:'시장 떡집',     item:'모듬떡 10% 할인',           questId:'q04',
      status:'used',   usedWhen:'지난주', walk:'걸어서 8분' },
  ];
  const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3479';   // 헷갈리는 글자 제거 25자 (M6 규칙)
  const CODES = new Map();

  const wait = (ms=120) => new Promise(r => setTimeout(r, ms));
  const clone = o => JSON.parse(JSON.stringify(o));
  const allSolved = () => ME.solved.concat(_load().solved || []);
  const isSolved = id => allSolved().some(s => s.questId === id);
  const drafts = () => _load().drafts || [];

  /* 프로토타입 전용: 출제 사진 자리를 채우는 도형 이미지.
     서버가 생기면 사라지고 photo에 실제 사진 URL이 들어온다. */
  function demoPhoto(seed) {
    let s = 7; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0, s / 4294967296);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const sky = pick(['#5B6470', '#6E7A82', '#48505C', '#7C838A']);
    const wall = pick(['#8A8177', '#9A8F82', '#726A61', '#A39687']);
    const dark = '#2C2F35';
    let p = '';
    for (let i = 0; i < 5; i++) {
      const x = Math.round(rnd() * 700), w = 80 + Math.round(rnd() * 220);
      const y = Math.round(100 + rnd() * 260), h = 600 - y;
      p += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
           '" fill="' + wall + '" opacity="' + (0.35 + rnd() * 0.5).toFixed(2) + '"/>';
    }
    for (let i = 0; i < 6; i++) {
      const x1 = Math.round(rnd() * 800), y1 = Math.round(rnd() * 600);
      const x2 = Math.round(rnd() * 800), y2 = Math.round(rnd() * 600);
      p += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
           '" stroke="' + dark + '" stroke-width="' + (1 + Math.round(rnd() * 4)) +
           '" opacity="' + (0.25 + rnd() * 0.4).toFixed(2) + '"/>';
    }
    p += '<circle cx="' + Math.round(120 + rnd() * 560) + '" cy="' + Math.round(60 + rnd() * 160) +
         '" r="' + Math.round(18 + rnd() * 26) + '" fill="#E8E2D6" opacity="0.5"/>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
      '<rect width="800" height="600" fill="' + sky + '"/>' + p +
      '<rect width="800" height="600" fill="' + dark + '" opacity="0.12"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  return {
    /* ── 조회 ─────────────────────────────────────────────────────────── */
    async getQuests() {
      await wait();
      const seed = clone(QUESTS);
      const mine = drafts().map(d => ({
        id: d.id, title: d.title, hint: d.hint, center: d.center, radius: d.radius,
        difficulty: d.difficulty, status: 'review', stats: clone(d.stats), area: d.area,
        mine: true,
      }));
      const st = _load();
      return seed.concat(mine).map(q => ({
        ...q,
        solvedByMe: isSolved(q.id),
        hintsUsed: (st.hints && st.hints[q.id]) || [],   // 지도가 좁힌 반경을 그릴 때 씀 (통합 ⑤)
      }));
    },

    async getQuest(id) {
      await wait();
      const d = drafts().find(x => x.id === id);
      if (d) return { ...clone(d), status:'review', solvedByMe: isSolved(id),
                      photo: d.photoDataUrl, features: null, mine: true,
                      hintsUsed: (_load().hints || {})[id] || [] };
      const q = QUESTS.find(x => x.id === id);
      if (!q) throw new Error('quest not found: ' + id);
      return { ...clone(q), solvedByMe: isSolved(id),
               photo: demoPhoto(id), features: null,
               hintsUsed: (_load().hints || {})[id] || [] };
    },

    async getMe() {
      await wait(50);
      const me = clone(ME);
      me.solved = allSolved();
      me.created = (ME.created || []).concat(drafts().map(d => d.id));
      return me;
    },

    async getConfig() { await wait(0); return clone(CONFIG); },

    /* ── 인증 흐름 ────────────────────────────────────────────────────── */
    /* 난수 발급 책임은 M4(문제 상세) — 열람 시점이 거기서 정해진다 (5.7 판정 5) */
    async issueNonce(questId) {
      await wait(200);
      return { questId, nonce: 'demo-' + Math.random().toString(36).slice(2, 10),
               ttlSec: 1800, issuedBy: 'server' };
    },

    /* 도움 사용 기록 — 서버 Attempt.hints_used의 프로토타입 대역 (5.7 판정 6) */
    recordHint(questId, kind) {
      const st = _load();
      st.hints = st.hints || {};
      const arr = st.hints[questId] || [];
      if (!arr.includes(kind)) arr.push(kind);
      st.hints[questId] = arr;
      _save(st);
      return arr.slice();
    },
    getHints(questId) { return ((_load().hints || {})[questId] || []).slice(); },

    /* 판정 결과 제출. 사진은 안 올라간다 — 점수·메타데이터·hints_used만.
       보상 배수는 서버가 계산한다. 프로토타입: 성공이면 발견으로 기록해
       도감이 같은 탭 안에서 이어지게 한다 (연출). */
    async submitAttempt(questId, payload) {
      await wait(400);
      if (payload && payload.verdictKey === 'pass' && !isSolved(questId)) {
        const st = _load();
        st.solved = st.solved || [];
        st.solved.push({ questId, at: '방금' });
        const d = (st.drafts || []).find(x => x.id === questId);
        if (d) { d.stats.attempts += 1; d.stats.solves += 1; }
        _save(st);
      }
      return { ok: true, verdict: payload?.verdictKey ?? 'unknown', reward: null,
               hints_used: this.getHints(questId), note: '프로토타입: 서버 미연결' };
    },

    /* ── 출제 ─────────────────────────────────────────────────────────── */
    /* payload: { hint, radius, difficulty, center, featureCount, photoDataUrl }
       사진 원본은 서버로 안 올라간다(계약). photoDataUrl은 세션 다리에만 저장되는
       프로토타입 대역 — 실서비스에선 특징점만 전송된다. */
    async createQuest(payload) {
      await wait(400);
      const id = 'new-' + Math.random().toString(36).slice(2, 8);
      const st = _load();
      st.drafts = st.drafts || [];
      st.drafts.push({
        id, title: payload.title || '내가 숨긴 장면',
        hint: payload.hint, radius: payload.radius, difficulty: payload.difficulty,
        center: payload.center || { lat: 36.6008, lng: 127.2966 },
        stats: { attempts: 0, solves: 0 }, area: '내 근처',
        photoDataUrl: payload.photoDataUrl || null,
      });
      _save(st);
      return { ok: true, id, status: 'review', note: '3명 인증 시 정식 승격' };
    },

    /* ── 쿠폰 (M6) ────────────────────────────────────────────────────── */
    async getMyCoupons() { await wait(); return clone(COUPONS); },

    async issueCouponCode(couponId) {
      await wait(200);
      const c = COUPONS.find(x => x.id === couponId);
      if (!c || c.status !== 'active') return { ok: false, reason: 'inactive' };
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      CODES.set(code, { couponId, expiresAt: Date.now() + CONFIG.coupon.codeTtlSec * 1000 });
      return { couponId, code, ttlSec: CONFIG.coupon.codeTtlSec, issuedBy: 'server' };
    },

    /* 코드 화면을 떠나면 무효화 (M6 내장본에서 승격 — 5.8 추가판정) */
    invalidateCode(code) { CODES.delete(code); return { ok: true }; },

    /* 점주가 확인하는 순간 = 과금 시점 (사업계획서 5-1 ①) */
    async redeemCoupon(code) {
      await wait(300);
      const rec = CODES.get(code);
      if (!rec) return { ok: false, reason: 'unknown' };
      if (Date.now() > rec.expiresAt) { CODES.delete(code); return { ok: false, reason: 'expired' }; }
      CODES.delete(code);
      const c = COUPONS.find(x => x.id === rec.couponId);
      if (c) { c.status = 'used'; c.usedWhen = '방금'; delete c.daysLeft; }
      return { ok: true, couponId: rec.couponId };
    },

    /* ── 화면 공통 (프로토타입 편의) ──────────────────────────────────── */
    getTheme() { return _load().theme || 'dark'; },
    setTheme(t) { const st = _load(); st.theme = t; _save(st); },
  };
})();

if (typeof module !== 'undefined') module.exports = API;
