"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// 画面サイズフック
// ─────────────────────────────────────────────
function useWindowSize() {
  const [size, setSize] = useState({ w: 1280, h: 720 });
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

// ─────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────
type Phase = "idle" | "warning" | "closed" | "passing" | "opening" | "done";
type TrainType = "local" | "express" | "shinkansen" | "steam";
type CrosserType = "person" | "child" | "car" | "bike";

interface Crosser {
  id: number;
  type: CrosserType;
  y: number;       // 画面下からのpx。道路の手前から奥へ移動
  dir: 1 | -1;     // 1=手前→奥(bottom増加), -1=奥→手前(bottom減少)
  speed: number;
  emoji: string;
  crashed: boolean;
}

interface TrainDef {
  id: TrainType; label: string; emoji: string; speed: number;
  color1: string; color2: string; accent: string;
}

const TRAINS: TrainDef[] = [
  { id:"local",      label:"ふつうでんしゃ", emoji:"🚃", speed:3.5, color1:"#1a6fc4", color2:"#0d3d73", accent:"#c8e8ff" },
  { id:"express",    label:"とっきゅう",     emoji:"🚄", speed:2.2, color1:"#c0392b", color2:"#7b241c", accent:"#ffd6d6" },
  { id:"shinkansen", label:"しんかんせん",   emoji:"🚅", speed:1.4, color1:"#f0f0f0", color2:"#aaa",    accent:"#005bac" },
  { id:"steam",      label:"きかんしゃ",     emoji:"🚂", speed:4.5, color1:"#2c2c2c", color2:"#111",    accent:"#cc4400" },
];

const CROSSER_DEFS: { type: CrosserType; speed: number }[] = [
  { type:"person", speed:0.35 },
  { type:"child",  speed:0.28 },
  { type:"car",    speed:1.2  },
  { type:"bike",   speed:0.6  },
];

// 道路幅（px）- キャラクターサイズの基準値
const ROAD_W = 400;
const GODZILLA_THEME_VIDEO_ID = "wr3Ehj3wycY";
const GODZILLA_THEME_PLAYER_ID = "godzilla-theme-player";

// ─────────────────────────────────────────────
// Audio helpers
// ─────────────────────────────────────────────
function getCtx(r: React.RefObject<AudioContext | null>): AudioContext {
  if (!r.current) (r as { current: AudioContext | null }).current = new AudioContext();
  return r.current!;
}

function playBell(ctx: AudioContext, t: number) {
  // アタックノイズ（音量を抑える）
  const ab = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.012), ctx.sampleRate);
  const ad = ab.getChannelData(0);
  for (let i = 0; i < ad.length; i++) ad[i] = (Math.random()*2-1)*(1-i/ad.length);
  const as_ = ctx.createBufferSource(); as_.buffer = ab;
  const ahpf = ctx.createBiquadFilter(); ahpf.type="highpass"; ahpf.frequency.value=3500;
  const ag = ctx.createGain(); ag.gain.setValueAtTime(0.25,t); ag.gain.exponentialRampToValueAtTime(0.001,t+0.012);
  as_.connect(ahpf); ahpf.connect(ag); ag.connect(ctx.destination);
  as_.start(t); as_.stop(t+0.015);
  // 倍音余韻（全体的に抑える）
  [{f:1480,a:0.12,d:0.6},{f:2960,a:0.05,d:0.32},{f:4440,a:0.025,d:0.18},{f:5920,a:0.015,d:0.10}]
    .forEach(({f,a,d})=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type="sine"; o.frequency.value=f;
      g.gain.setValueAtTime(a,t+0.002); g.gain.exponentialRampToValueAtTime(0.0001,t+d);
      o.start(t); o.stop(t+d+0.01);
    });
}

function createRumble(ctx: AudioContext, type: TrainType): {stop:()=>void} {
  // コンプレッサーで音割れなく大音量に
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 6;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.1;
  comp.connect(ctx.destination);

  // ── ベースノイズ（低音ゴロゴロ） ──
  const len = ctx.sampleRate*3;
  const buf = ctx.createBuffer(1,len,ctx.sampleRate);
  const d = buf.getChannelData(0);
  for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
  const src=ctx.createBufferSource(); src.buffer=buf; src.loop=true;
  const bpf=ctx.createBiquadFilter(); bpf.type="bandpass";
  bpf.frequency.value=type==="shinkansen"?160:type==="steam"?100:190; bpf.Q.value=0.7;
  const lpf=ctx.createBiquadFilter(); lpf.type="lowpass"; lpf.frequency.value=type==="shinkansen"?400:650;
  const lfo=ctx.createOscillator(); const lfoG=ctx.createGain();
  lfo.type="square";
  lfo.frequency.value=type==="shinkansen"?13:type==="steam"?3.5:type==="express"?9:6;
  lfoG.gain.value=type==="shinkansen"?0.15:0.30;
  lfo.connect(lfoG);
  const master=ctx.createGain();
  master.gain.value=type==="shinkansen"?0.55:type==="steam"?0.80:0.70;
  lfoG.connect(master.gain);
  src.connect(bpf); bpf.connect(lpf); lpf.connect(master); master.connect(comp);
  src.start(); lfo.start();

  // ── ガタンゴトン衝撃音（レールの継ぎ目） ──
  let chunkTimer: ReturnType<typeof setInterval>|null = null;
  if(type !== "shinkansen") {
    const intervalMs = type==="steam" ? 600 : type==="express" ? 280 : 380;
    chunkTimer = setInterval(()=>{
      const t = ctx.currentTime;
      const impLen = Math.floor(ctx.sampleRate * 0.06);
      const impBuf = ctx.createBuffer(1, impLen, ctx.sampleRate);
      const impD = impBuf.getChannelData(0);
      for(let i=0;i<impLen;i++) impD[i] = (Math.random()*2-1) * Math.exp(-i/(impLen*0.2));
      const impSrc = ctx.createBufferSource(); impSrc.buffer = impBuf;
      const impLpf = ctx.createBiquadFilter(); impLpf.type="lowpass"; impLpf.frequency.value=350;
      const impG = ctx.createGain();
      impG.gain.setValueAtTime(1.2, t);
      impG.gain.exponentialRampToValueAtTime(0.001, t+0.06);
      impSrc.connect(impLpf); impLpf.connect(impG); impG.connect(comp);
      impSrc.start(t); impSrc.stop(t+0.07);
    }, intervalMs);
  }

  setTimeout(()=>{ try{bpf.frequency.exponentialRampToValueAtTime(bpf.frequency.value*0.65,ctx.currentTime+0.9);}catch{/**/} },1600);
  return {stop:()=>{
    try{src.stop();lfo.stop();}catch{/**/}
    if(chunkTimer) clearInterval(chunkTimer);
  }};
}

function createSteamChuff(ctx: AudioContext): {stop:()=>void} {
  let on=true;
  const tick=()=>{
    if(!on) return;
    const t=ctx.currentTime;
    const bl=Math.floor(ctx.sampleRate*0.16);
    const b=ctx.createBuffer(1,bl,ctx.sampleRate);
    const bd=b.getChannelData(0);
    for(let i=0;i<bl;i++) bd[i]=Math.random()*2-1;
    const s=ctx.createBufferSource(); s.buffer=b;
    const hpf=ctx.createBiquadFilter(); hpf.type="highpass"; hpf.frequency.value=700;
    const lpf=ctx.createBiquadFilter(); lpf.type="lowpass"; lpf.frequency.value=2800;
    const g=ctx.createGain();
    g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.28,t+0.04);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.16);
    s.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(ctx.destination);
    s.start(t); s.stop(t+0.18);
    setTimeout(tick,440);
  };
  tick();
  return {stop:()=>{on=false;}};
}

function playHorn(ctx: AudioContext, type: TrainType) {
  const t=ctx.currentTime;
  if(type==="steam"){
    [262,330,392].forEach((f,i)=>{
      const o=ctx.createOscillator(), vib=ctx.createOscillator(), vg=ctx.createGain(), g=ctx.createGain();
      vib.frequency.value=5; vg.gain.value=5;
      vib.connect(vg); vg.connect(o.frequency);
      o.connect(g); g.connect(ctx.destination);
      o.type="sawtooth"; o.frequency.value=f;
      g.gain.setValueAtTime(0,t+i*0.03); g.gain.linearRampToValueAtTime(0.17,t+i*0.03+0.08);
      g.gain.setValueAtTime(0.17,t+1.0); g.gain.exponentialRampToValueAtTime(0.001,t+1.4);
      o.start(t); o.stop(t+1.5); vib.start(t); vib.stop(t+1.5);
    });
  } else if(type==="shinkansen"){
    [622,830].forEach(f=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type="sine"; o.frequency.value=f;
      g.gain.setValueAtTime(0.2,t); g.gain.setValueAtTime(0.2,t+0.3); g.gain.exponentialRampToValueAtTime(0.001,t+0.5);
      o.start(t); o.stop(t+0.6);
    });
  } else if(type==="express"){
    [440,554].forEach((f,i)=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type="sawtooth"; o.frequency.value=f;
      g.gain.setValueAtTime(0,t+i*0.05); g.gain.linearRampToValueAtTime(0.14,t+i*0.05+0.05);
      g.gain.setValueAtTime(0.14,t+0.55); g.gain.exponentialRampToValueAtTime(0.001,t+0.85);
      o.start(t); o.stop(t+0.9);
    });
  } else {
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type="sawtooth"; o.frequency.value=392;
    g.gain.setValueAtTime(0.14,t); g.gain.setValueAtTime(0.14,t+0.4); g.gain.exponentialRampToValueAtTime(0.001,t+0.65);
    o.start(t); o.stop(t+0.7);
  }
}

// ─────────────────────────────────────────────
// メインコンポーネント
// ─────────────────────────────────────────────
let crosserIdSeq = 0;

export default function FumikiriApp() {
  const { w: W, h: H } = useWindowSize();
  // rail center Y (matches Rail top:62% and half of rail container height)
  const yRail = H * 0.62 + 28;
  const [phase, setPhase]               = useState<Phase>("idle");
  const [barrierAngle, setBarrierAngle] = useState(-85); // -85=上向き, 0=水平
  const [trainVisible, setTrainVisible] = useState(false);
  const [trainCount, setTrainCount]     = useState(0);
  const [selectedTrain, setSelectedTrain] = useState<TrainType>("local");
  const [crossers, setCrossers]         = useState<Crosser[]>([]);
  const [score, setScore]               = useState(0);
  const [danger, setDanger]             = useState(false); // 危険フラッシュ
  const [smokeFrames, setSmokeFrames]   = useState(0);     // 煙アニメ用
  const [godzilla, setGodzilla]         = useState(false); // ゴジラ襲来
  const [godzillaX, setGodzillaX]       = useState(110);   // ゴジラX位置(%)
  const [heatRay, setHeatRay]           = useState(false); // 熱線
  const [trainFromLeft, setTrainFromLeft] = useState(true); // next train direction

  const audioCtxRef  = useRef<AudioContext | null>(null);
  const bellRef      = useRef<ReturnType<typeof setInterval>|null>(null);
  const trainSndRef  = useRef<{stop:()=>void}|null>(null);
  const crosserTimer = useRef<ReturnType<typeof setInterval>|null>(null);
  const smokeTimer   = useRef<ReturnType<typeof setInterval>|null>(null);
  const godzillaThemePlayerRef = useRef<{ playVideo?: () => void; stopVideo?: () => void; seekTo?: (seconds: number, allowSeekAhead?: boolean) => void; destroy?: () => void } | null>(null);
  const godzillaThemeReadyRef = useRef(false);
  const godzillaThemePendingPlayRef = useRef(false);

  const trainDef = TRAINS.find(t=>t.id===selectedTrain)!;
  const isWarning = ["warning","closed","passing"].includes(phase);
  const canPress  = phase==="idle" || phase==="done";
  const isOpen    = phase==="idle" || phase==="done" || phase==="opening";

  // 渡れる人・車を動かす（y方向: 道路を縦断）
  useEffect(()=>{
    const id = setInterval(()=>{
      setCrossers(prev=>{
        return prev.map(c=>{
          if(c.crashed) return c;
          // 消失点(VP=62%)に近いほど速度を落とす（遠近感）
          // y小=手前(bottom低い), y大=奥(消失点に近い)
          const VP = 62;
          const t = Math.max(0, Math.min(1, 1 - c.y / VP)); // 1=手前, 0=奥
          const scale = Math.max(0.2, t);               // 0.2〜1.0
          const moveAmount = c.speed * scale * 1.8;
          const ny = c.y + c.dir * moveAmount;
          return {...c, y: ny};
        // 手前(y<0)または消失点(y>62)を超えたら削除
        }).filter(c=>c.y>-5 && c.y<63);
      });
    }, 50);
    return ()=>clearInterval(id);
  },[]);

  // 電車通過中に踏切内にいる渡り者を検出
  // 判定: 線路高さ(bottom 60〜64%)かつ道路内（画面中央の道路幅内）のみ
  useEffect(()=>{
    if(phase!=="passing") return;
    const id = setInterval(()=>{
      setCrossers(prev=>{
        let hit=false;
        const next = prev.map(c=>{
          // 線路は bottom:62% → y が 60〜64% の範囲が踏切内
          if(!c.crashed && c.y>60 && c.y<64){
            hit=true;
            return {...c, crashed:true};
          }
          return c;
        });
        if(hit){
          setDanger(true);
          setTimeout(()=>setDanger(false),800);
        }
        return next;
      });
    },50);
    return ()=>clearInterval(id);
  },[phase]);

  const stopBell = useCallback(()=>{
    if(bellRef.current){clearInterval(bellRef.current);bellRef.current=null;}
  },[]);
  const stopTrainSnd = useCallback(()=>{
    trainSndRef.current?.stop(); trainSndRef.current=null;
  },[]);

  const startBell = useCallback(()=>{
    const ctx=getCtx(audioCtxRef);
    playBell(ctx,ctx.currentTime);
    playBell(ctx,ctx.currentTime+0.40);
    bellRef.current=setInterval(()=>{
      const t=ctx.currentTime;
      playBell(ctx,t); playBell(ctx,t+0.40);
    },800);
  },[]);

  // 煙アニメ（蒸気機関車通過中）
  const startSmoke = useCallback(()=>{
    smokeTimer.current=setInterval(()=>setSmokeFrames(f=>(f+1)%60),80);
  },[]);
  const stopSmoke = useCallback(()=>{
    if(smokeTimer.current){clearInterval(smokeTimer.current);smokeTimer.current=null;}
    setSmokeFrames(0);
  },[]);

  const stopGodzillaTheme = useCallback(()=>{
    godzillaThemePendingPlayRef.current = false;
    try {
      godzillaThemePlayerRef.current?.stopVideo?.();
    } catch { /**/ }
  },[]);

  const ensureGodzillaThemePlayer = useCallback(()=>{
    if (typeof window === "undefined") return;
    if (godzillaThemePlayerRef.current) return;

    const ytWindow = window as Window & {
      YT?: { Player?: new (elementId: string, options: Record<string, unknown>) => { playVideo?: () => void } };
      onYouTubeIframeAPIReady?: () => void;
    };

    if (!document.getElementById(GODZILLA_THEME_PLAYER_ID)) {
      const mount = document.createElement("div");
      mount.id = GODZILLA_THEME_PLAYER_ID;
      mount.style.position = "fixed";
      mount.style.left = "-9999px";
      mount.style.width = "1px";
      mount.style.height = "1px";
      mount.style.pointerEvents = "none";
      document.body.appendChild(mount);
    }

    const createPlayer = () => {
      if (!ytWindow.YT?.Player || godzillaThemePlayerRef.current) return;
      godzillaThemePlayerRef.current = new ytWindow.YT.Player(GODZILLA_THEME_PLAYER_ID, {
        width: "1",
        height: "1",
        videoId: GODZILLA_THEME_VIDEO_ID,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            godzillaThemeReadyRef.current = true;
            if (godzillaThemePendingPlayRef.current) {
              godzillaThemePendingPlayRef.current = false;
              try {
                godzillaThemePlayerRef.current?.seekTo?.(0, true);
                godzillaThemePlayerRef.current?.playVideo?.();
              } catch { /**/ }
            }
          },
        },
      });
    };

    if (ytWindow.YT?.Player) {
      createPlayer();
      return;
    }

    const prevReady = ytWindow.onYouTubeIframeAPIReady;
    ytWindow.onYouTubeIframeAPIReady = () => {
      if (prevReady) prevReady();
      createPlayer();
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
  },[]);

  const playGodzillaTheme = useCallback(()=>{
    ensureGodzillaThemePlayer();
    if (godzillaThemeReadyRef.current && godzillaThemePlayerRef.current) {
      try {
        godzillaThemePlayerRef.current.seekTo?.(0, true);
        godzillaThemePlayerRef.current.playVideo?.();
      } catch { /**/ }
      return;
    }
    godzillaThemePendingPlayRef.current = true;
  },[ensureGodzillaThemePlayer]);

  const startSequence = useCallback(()=>{
    if(!canPress) return;
    setTrainCount(c=>c+1);
    setPhase("warning");
    startBell();

    setTimeout(()=>{
      setBarrierAngle(0);
      setPhase("closed");

      setTimeout(()=>{
        const ctx=getCtx(audioCtxRef);
        playHorn(ctx,trainDef.id);
        trainSndRef.current = trainDef.id==="steam"
          ? createSteamChuff(ctx) : createRumble(ctx,trainDef.id);
        if(trainDef.id==="steam") startSmoke();
        // alternate direction each time (true = left->right)
        setTrainFromLeft(prev => !prev);
        setTrainVisible(true);
        setPhase("passing");

        setTimeout(()=>{
          setTrainVisible(false);
          stopBell(); stopTrainSnd(); stopSmoke();
          setBarrierAngle(-85);
          setPhase("opening");
          setTimeout(()=>{
            setPhase("done");
            setTimeout(()=>setPhase("idle"),1200);
          },1600);
        }, trainDef.speed*1000+500);
      },1000);
    },1600);
  },[canPress,startBell,stopBell,stopTrainSnd,trainDef,startSmoke,stopSmoke]);

  // 渡り者を追加（道路を縦断: 手前→奥 or 奥→手前）
  const addCrosser = useCallback((type: CrosserType)=>{
    if(!isOpen) return;
    const def = CROSSER_DEFS.find(d=>d.type===type)!;
    const fromBottom = Math.random()>0.5;
    const newC: Crosser = {
      id: ++crosserIdSeq,
      type,
      emoji: type,
      // 手前(y=2)から奥(y=60)、または奥(y=60)から手前(y=2)
      // 消失点はbottom=62%なのでy=61が限界
      y: fromBottom ? 2 : 60,
      dir: fromBottom ? 1 : -1,
      speed: def.speed,
      crashed: false,
    };
    setCrossers(prev=>[...prev,newC]);
    setScore(s=>s+10);
  },[isOpen]);

  // ゴジラ襲来
  const startGodzilla = useCallback(()=>{
    if(godzilla) return;
    setGodzilla(true);
    playGodzillaTheme();
    // 全キャラをクラッシュ
    setCrossers(prev=>prev.map(c=>({...c,crashed:true})));
    stopBell(); stopTrainSnd(); stopSmoke();
    setPhase("warning");
    // 少し遅れて熱線発射
    setTimeout(()=>setHeatRay(true), 600);
  },[godzilla, playGodzillaTheme, stopBell, stopTrainSnd, stopSmoke]);

  useEffect(()=>()=>{stopBell();stopTrainSnd();stopSmoke();stopGodzillaTheme();godzillaThemePlayerRef.current?.destroy?.();},[stopBell,stopTrainSnd,stopSmoke,stopGodzillaTheme]);

  return (
    <div className="relative w-screen h-screen overflow-hidden select-none"
      style={{background: danger?"#ff000033":"transparent"}}>

      {/* 空 */}
      <div className="absolute inset-0"
        style={{background:"linear-gradient(180deg,#3a8fc8 0%,#6ab8d8 40%,#a8d8ee 100%)"}}/>

      {/* 雲 */}
      <Cloud cls="cloud1" top={25} size={110}/>
      <Cloud cls="cloud2" top={60} size={70}/>
      <Cloud cls="cloud3" top={12} size={140}/>
      <Cloud cls="cloud4" top={45} size={55}/>

      {/* 山 */}
      <svg className="absolute left-0 w-full" style={{bottom:"37%",pointerEvents:"none"}}
        viewBox="0 0 1200 180" preserveAspectRatio="none">
        <polygon points="0,180 80,70 200,120 340,25 490,100 640,35 790,105 940,20 1080,75 1200,45 1200,180" fill="#5a9a68" opacity="0.55"/>
        <polygon points="0,180 60,90 170,130 310,45 460,110 610,50 760,115 910,30 1060,85 1200,55 1200,180" fill="#3d7a4a"/>
        <polygon points="340,25 318,62 362,62" fill="white" opacity="0.85"/>
        <polygon points="940,20 918,58 962,58" fill="white" opacity="0.85"/>
      </svg>

      {/* 地面 */}
      <div className="absolute left-0 w-full"
        style={{bottom:0,height:"37%",background:"linear-gradient(180deg,#5a9e3a 0%,#3d7a28 45%,#2d5e1e 100%)"}}/>

      {/* 田んぼ・畑 */}
      <svg className="absolute left-0 w-full" style={{bottom:0,height:"37%",pointerEvents:"none"}}
        viewBox="0 0 1200 230" preserveAspectRatio="none">
        <rect x="15" y="25" width="190" height="85" rx="3" fill="#4a8c30" stroke="#3a7020" strokeWidth="2"/>
        {[0,1,2,3].map(i=><line key={i} x1={15+i*48} y1="25" x2={15+i*48} y2="110" stroke="#3a7020" strokeWidth="1.5"/>)}
        {[0,1].map(i=><line key={i} x1="15" y1={25+i*42} x2="205" y2={25+i*42} stroke="#3a7020" strokeWidth="1.5"/>)}
        <rect x="1000" y="18" width="175" height="92" rx="3" fill="#4a8c30" stroke="#3a7020" strokeWidth="2"/>
        {[0,1,2,3].map(i=><line key={i} x1={1000+i*44} y1="18" x2={1000+i*44} y2="110" stroke="#3a7020" strokeWidth="1.5"/>)}
        <rect x="240" y="45" width="130" height="65" rx="2" fill="#7a6030" stroke="#5a4020" strokeWidth="2"/>
        {[0,1,2,3,4].map(i=><line key={i} x1={252+i*24} y1="45" x2={252+i*24} y2="110" stroke="#5a4020" strokeWidth="1.5"/>)}
      </svg>

      {/* 道路（SVG台形で奥行き表現: 手前が広く奥が狭い） */}
      <RoadSVG W={W} H={H}/>

      {/* 縁石・歩道 */}
      <div className="absolute left-0 w-full" style={{bottom:"37%",height:10,background:"#999",zIndex:5}}/>
      <div className="absolute left-0 w-full" style={{bottom:"calc(37% + 10px)",height:22,
        background:"repeating-linear-gradient(90deg,#d0d0d0 0,#d0d0d0 38px,#b8b8b8 38px,#b8b8b8 76px)",zIndex:5}}/>

      {/* 電柱 */}
      <ElectricPole x="13%"/>
      <ElectricPole x="74%"/>

      {/* 建物（住宅街） */}
      <Building x="2%"  w={70} h={90}  color="#e8d8c8" roofColor="#b85c3e" windows={4}/>
      <Building x="8%"  w={55} h={75}  color="#d8c8b8" roofColor="#a04c2e" windows={3}/>
      <Building x="14%" w={48} h={65}  color="#c8b8a8" roofColor="#904c2e" windows={2}/>
      <Building x="75%" w={60} h={80}  color="#d8c8b8" roofColor="#a04c2e" windows={3}/>
      <Building x="82%" w={52} h={70}  color="#c8b8a8" roofColor="#904c2e" windows={2}/>
      <Building x="88%" w={45} h={95}  color="#e8d8c8" roofColor="#b85c3e" windows={4}/>
      <Building x="94%" w={38} h={60}  color="#d0c0b0" roofColor="#985c3e" windows={2}/>

      {/* 線路 */}
      <Rail/>

      {/* 渡り者（踏切の道路を縦断: 線路と垂直方向に移動） */}
      {crossers.map(c=>{
        // c.y is expressed as bottom percent (0..100)
        // Compute road width at this vertical position using the same math as RoadSVG
        const cx = W / 2;
        const vpY = H * (1 - 0.62); // 消失点Y
        const yBot = H;
        // c.y is bottom% (0=bottom/front, larger=up/toward vanishing point)
        // convert to top-based Y in px for RoadSVG calculations
        const yPx = H * (1 - c.y / 100);
        const tW = Math.max(0, Math.min(1, (yPx - vpY) / (yBot - vpY))); // 0=奥,1=手前
        const roadHalfWAtY = W * (0.20 + 0.70 * tW) / 2; // half width in px
        const fullRoadWAtY = Math.max(20, roadHalfWAtY * 2);
        // レーンオフセット: 半幅 (roadHalfWAtY) を基準にして配置する（はみ出し防止）
        let laneOffsetPx = c.dir * -roadHalfWAtY * 0.6;
        const maxOffset = roadHalfWAtY * 0.9; // 要素が道路外に出ないよう最大値を制限
        laneOffsetPx = Math.sign(laneOffsetPx) * Math.min(Math.abs(laneOffsetPx), maxOffset);
        // 見た目スケールは tW（0=奥,1=手前）を使って計算し、
        // サイズは dynRoadW（基準ROAD_Wにscaleを掛けた値）で決定する。
        const t = tW; // 0..1 (奥→手前)
        const scale = 0.2 + 0.8 * t;
        // Compute drawable width based on actual road width at this Y so sizes follow the road
        const dynRoadWRaw = Math.round(fullRoadWAtY * 0.6);
        // Cap dynRoadW to avoid excessive sizes on very wide screens:
        // - at least 12px, - at most 12% of viewport width, and not hugely larger than base ROAD_W
        const dynRoadW = Math.max(12, Math.min(dynRoadWRaw, Math.round(Math.min(W * 0.12, ROAD_W * 1.1))));
        const opacity = Math.max(0, t);

        return (
          <div key={c.id} className="absolute"
            style={{
              left:`${cx + laneOffsetPx}px`,
              // sink element slightly (pixels) so it visually sits on the road
              bottom:`calc(${c.y}% - ${Math.round(dynRoadW * 0.08)}px)`,
              transform:`translateX(-50%)`,
              transformOrigin:"bottom center",
              opacity,
              zIndex: Math.floor(100 - c.y),
              filter: c.crashed?"grayscale(1) brightness(0.4)":"none",
              transition:"filter 0.2s, transform 0.12s",
              display:"flex",
              justifyContent:"center",
            }}>
            {c.crashed
              ? <span style={{fontSize:24}}>💥</span>
              : <CrosserSVG type={c.type} dir={c.dir} roadW={dynRoadW}/>
            }
          </div>
        );
      })}

      {/* 電車 */}
      {trainVisible && <TrainSVG def={trainDef} smokeFrame={smokeFrames} fromLeft={trainFromLeft} yRail={yRail}/>}

      {/* 踏切 */}
      <FumikiriStructure barrierAngle={barrierAngle} isWarning={isWarning} W={W} H={H} trainFromLeft={trainFromLeft}/>

      {/* ===== UI ===== */}

      {/* 電車選択 */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center px-4" style={{zIndex:50}}>
        {TRAINS.map(t=>(
          <button key={t.id} onClick={()=>canPress&&setSelectedTrain(t.id)}
            className="flex flex-col items-center px-3 py-1.5 rounded-xl font-bold transition-all"
            style={{
              background:selectedTrain===t.id?"#fff":"rgba(255,255,255,0.45)",
              border:selectedTrain===t.id?"3px solid #e74c3c":"3px solid transparent",
              color:"#333", transform:selectedTrain===t.id?"scale(1.1)":"scale(1)",
              cursor:canPress?"pointer":"default", opacity:canPress?1:0.65,
              boxShadow:selectedTrain===t.id?"0 4px 12px rgba(0,0,0,0.25)":"none",
            }}>
            <span style={{fontSize:26}}>{t.emoji}</span>
            <span style={{fontSize:10}}>{t.label}</span>
          </button>
        ))}
      </div>

      {/* 渡らせるボタン */}
      <div className="absolute top-1/2 -translate-y-1/2 flex flex-col gap-2" style={{zIndex:50, left: 'clamp(40px, 8%, 120px)'}}>
        <div className="text-white text-xs font-bold mb-1 text-center"
          style={{textShadow:"1px 1px 2px #000"}}>わたらせる</div>
        {CROSSER_DEFS.map(d=>(
          <button key={d.type} onClick={()=>addCrosser(d.type)}
            className="rounded-xl px-3 py-2 font-bold text-lg transition-all"
            style={{
              background:isOpen?"rgba(255,255,255,0.85)":"rgba(180,180,180,0.5)",
              cursor:isOpen?"pointer":"not-allowed",
              border:isOpen?"2px solid #27ae60":"2px solid #aaa",
              boxShadow:isOpen?"0 3px 8px rgba(0,0,0,0.2)":"none",
            }}>
            {d.type==="person"?"🚶":d.type==="child"?"🧒":d.type==="car"?"🚗":"🚲"}
          </button>
        ))}
      </div>

      {/* スコア */}
      <div className="absolute top-4 right-4 text-white font-bold text-lg"
        style={{textShadow:"1px 1px 3px #000",zIndex:50}}>
        ⭐ {score}てん
      </div>

      {/* 電車呼ぶボタン */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2" style={{zIndex:50}}>
        <button onClick={startSequence} disabled={!canPress}
          className="px-8 py-3 rounded-full text-white text-xl font-bold shadow-lg transition-all"
          style={{
            background:canPress?"linear-gradient(135deg,#e74c3c,#c0392b)":"#999",
            cursor:canPress?"pointer":"not-allowed",
            boxShadow:canPress?"0 6px 20px rgba(231,76,60,0.5)":"none",
          }}>
          {trainDef.emoji} でんしゃを よぼう！
        </button>
        {trainCount>0&&(
          <div className="text-white text-sm font-bold" style={{textShadow:"1px 1px 3px #000"}}>
            でんしゃ {trainCount}かい とおったよ！
          </div>
        )}
        {/* ゴジラ襲来ボタン */}
        <button onClick={startGodzilla} disabled={godzilla}
          className="px-6 py-3 rounded-full text-white text-xl font-black shadow-lg transition-all mt-2"
          style={{
            background:godzilla?"#555":"linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)",
            cursor:godzilla?"not-allowed":"pointer",
            boxShadow:godzilla?"none":"0 6px 24px rgba(0,0,0,0.7), 0 0 20px rgba(0,207,255,0.4)",
            border:"2px solid #00cfff",
            letterSpacing:"0.05em",
          }}>
          🦖 ゴジラ襲来！！
        </button>
      </div>

      {/* フェーズ表示 */}
      <PhaseLabel phase={phase}/>

      {/* 危険フラッシュ */}
      {danger&&(
        <div className="absolute inset-0 pointer-events-none"
          style={{background:"rgba(255,0,0,0.25)",zIndex:100}}/>
      )}

      {/* ゴジラ */}
      {godzilla && <GodzillaSVG heatRay={heatRay}/>}

      {/* ゲームオーバーオーバーレイ */}
      {godzilla && (
        <div className="absolute inset-x-0 bottom-[8%] flex flex-col items-center pointer-events-none"
          style={{zIndex:300}}>
          <div className="text-white font-black text-center"
            style={{
              fontSize:"clamp(2rem,8vw,5rem)",
              textShadow:"0 0 30px #ff4400, 2px 2px 0 #000, -2px -2px 0 #000",
              animation:"pulse 0.5s infinite alternate",
            }}>
            🦖 GAME OVER 🦖
          </div>
          <div className="text-yellow-300 font-bold mt-4"
            style={{fontSize:"clamp(1rem,3vw,2rem)", textShadow:"1px 1px 4px #000"}}>
            ゴジラが あらわれた！！
          </div>
          <button className="mt-8 px-8 py-3 rounded-full font-bold text-white text-xl pointer-events-auto"
            style={{background:"linear-gradient(135deg,#e74c3c,#c0392b)",boxShadow:"0 6px 20px rgba(231,76,60,0.6)"}}
            onClick={()=>{stopGodzillaTheme();setGodzilla(false);setHeatRay(false);setPhase("idle");setCrossers([]);}}>
            もう一度あそぶ
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 背景パーツ
// ─────────────────────────────────────────────
function Cloud({cls,top,size}:{cls:string;top:number;size:number}){
  return(
    <div className={`absolute ${cls}`} style={{top,left:-size*2}}>
      <div className="relative" style={{width:size*1.7,height:size*0.65}}>
        <div className="absolute rounded-full" style={{width:size*0.95,height:size*0.52,bottom:0,left:size*0.08,background:"rgba(255,255,255,0.96)"}}/>
        <div className="absolute rounded-full" style={{width:size*0.72,height:size*0.58,bottom:0,left:size*0.52,background:"rgba(255,255,255,0.96)"}}/>
        <div className="absolute rounded-full" style={{width:size*0.68,height:size*0.65,bottom:0,left:size*0.28,background:"white"}}/>
        <div className="absolute rounded-full" style={{width:size*0.52,height:size*0.42,bottom:0,left:size*0.95,background:"rgba(255,255,255,0.9)"}}/>
      </div>
    </div>
  );
}

function ElectricPole({x}:{x:string}){
  return(
    <div className="absolute" style={{left:x,bottom:"calc(37% + 32px)",zIndex:6}}>
      <svg width="44" height="130" viewBox="0 0 44 130">
        <rect x="20" y="0" width="4" height="130" fill="#8B7355"/>
        <rect x="4" y="18" width="36" height="5" rx="1" fill="#6B5A3E"/>
        <rect x="9" y="34" width="26" height="4" rx="1" fill="#6B5A3E"/>
        {[6,14,22,30].map(px=>(
          <ellipse key={px} cx={px} cy="20" rx="3.5" ry="5" fill="#e0e0e0" stroke="#aaa" strokeWidth="0.5"/>
        ))}
        <path d="M6,20 Q22,27 38,20" stroke="#444" strokeWidth="1.2" fill="none"/>
        <path d="M11,36 Q22,42 33,36" stroke="#444" strokeWidth="1.2" fill="none"/>
      </svg>
    </div>
  );
}

function Building({x,w,h,color,roofColor,windows}:{x:string;w:number;h:number;color:string;roofColor:string;windows:number}){
  const showChimney = ((w * 31 + h * 17 + x.charCodeAt(0)) % 2) === 0;
  return(
    <div className="absolute" style={{left:x,bottom:"calc(37% + 32px)",zIndex:4}}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {/* 建物本体 */}
        <rect x="0" y="0" width={w} height={h} fill={color} stroke="#777" strokeWidth="1"/>
        {/* 屋根 */}
        <polygon points={`0,0 ${w/2},${-h*0.25} ${w},0`} fill={roofColor}/>
        <polygon points={`0,0 ${w/2},${-h*0.25} ${w},0`} fill="none" stroke="#555" strokeWidth="1"/>
        {/* 屋根瓦テクスチャ */}
        {Array.from({length:Math.floor(h*0.25/4)}).map((_,i)=>(
          <line key={i} x1="0" y1={-i*4} x2={w} y2={-i*4} stroke="#555" strokeWidth="0.5" opacity="0.3"/>
        ))}
        {/* 窓 */}
        {Array.from({length:Math.min(windows,Math.floor(h/25))}).map((_,row)=>
          Array.from({length:Math.min(3,Math.floor(w/20))}).map((_,col)=>{
            const wx=8+col*(w/3.5), wy=12+row*22;
            if(wx+12>w-8) return null;
            return(
              <g key={`${row}-${col}`}>
                <rect x={wx} y={wy} width="12" height="14" rx="1" fill="#e8f4ff" stroke="#666" strokeWidth="0.8"/>
                <line x1={wx+6} y1={wy} x2={wx+6} y2={wy+14} stroke="#666" strokeWidth="0.5"/>
                <line x1={wx} y1={wy+7} x2={wx+12} y2={wy+7} stroke="#666" strokeWidth="0.5"/>
                {/* カーテン */}
                <rect x={wx+1} y={wy+1} width="4" height="12" rx="0.5" fill="#ffd0d0" opacity="0.6"/>
              </g>
            );
          })
        )}
        {/* 玄関ドア */}
        <rect x={w/2-8} y={h-24} width="16" height="24" rx="2" fill="#8B6040" stroke="#555" strokeWidth="1"/>
        <circle cx={w/2+4} cy={h-12} r="1.5" fill="#ddd"/>
        {/* 玄関上の庇 */}
        <rect x={w/2-12} y={h-26} width="24" height="4" rx="1" fill={roofColor}/>
        {/* 煙突 */}
        {showChimney && (
          <rect x={w*0.7} y={-h*0.2} width="4" height={h*0.15} fill="#666" stroke="#444" strokeWidth="0.5"/>
        )}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────
// 渡り者SVG（45度後方視点・進行方向対応）
// dir=1: 奥へ向かう（上方向）= 背中が見える
// dir=-1: 手前へ向かう（下方向）= 正面が見える
// ─────────────────────────────────────────────
function CrosserSVG({type, dir, roadW}:{type:CrosserType; dir:1|-1; roadW:number}){
  const carW   = Math.round(roadW * 0.45);
  const personW= Math.round(roadW * 0.15);
  const bikeW  = Math.round(roadW * 0.20);

  if(type === "car"){
    const w=carW, h=Math.round(carW*1.6);
    // dir=1(奥向き): フロントが上、dir=-1(手前向き): フロントが下
    const goingAway = dir===1;
    return(
      <svg width={w} height={h} viewBox="0 0 44 70" style={{display:"block"}}>
        {/* 車体下部（床面） */}
        <rect x="2" y={goingAway?30:10} width="40" height="30" rx="4" fill="#c0392b"/>
        {/* 車体上部（ルーフ・側面） */}
        <rect x="6" y={goingAway?14:14} width="32" height="26" rx="4" fill="#e74c3c"/>
        {/* フロントガラス */}
        <rect x="7" y={goingAway?14:34} width="30" height="12" rx="2" fill="#aee6ff" opacity="0.9"/>
        {/* リアガラス */}
        <rect x="7" y={goingAway?34:14} width="30" height="10" rx="2" fill="#aee6ff" opacity="0.55"/>
        {/* ヘッドライト */}
        <rect x="4"  y={goingAway?8:56}  width="10" height="5" rx="2" fill="#fffaaa"/>
        <rect x="30" y={goingAway?8:56}  width="10" height="5" rx="2" fill="#fffaaa"/>
        {/* テールライト */}
        <rect x="4"  y={goingAway?58:8}  width="10" height="5" rx="2" fill="#ff4444"/>
        <rect x="30" y={goingAway?58:8}  width="10" height="5" rx="2" fill="#ff4444"/>
        {/* タイヤ（左右） */}
        <rect x="0"  y="14" width="5" height="14" rx="2" fill="#222"/>
        <rect x="39" y="14" width="5" height="14" rx="2" fill="#222"/>
        <rect x="0"  y="42" width="5" height="14" rx="2" fill="#222"/>
        <rect x="39" y="42" width="5" height="14" rx="2" fill="#222"/>
        {/* 側面ドア */}
        <rect x="0"  y="26" width="5" height="16" rx="1" fill="#a93226"/>
        <rect x="39" y="26" width="5" height="16" rx="1" fill="#a93226"/>
      </svg>
    );
  }

  if(type === "bike"){
    const w=bikeW, h=Math.round(bikeW*2.8);
    const goingAway = dir===1;
    const skinColor="#f5a623"; const bodyColor="#27ae60";
    // 車輪は地面と垂直（縦長楕円）で表現
    const wheelRx = 3, wheelRy = 9;
    const frontWheelY = goingAway ? 44 : 12;
    const rearWheelY  = goingAway ? 12 : 44;
    return(
      <svg width={w} height={h} viewBox="0 0 22 56" style={{display:"block"}}>
        {/* 車輪（側面楕円） */}
        <ellipse cx="11" cy={frontWheelY} rx={wheelRx} ry={wheelRy} fill="none" stroke="#333" strokeWidth="2.5"/>
        <ellipse cx="11" cy={rearWheelY}  rx={wheelRx} ry={wheelRy} fill="none" stroke="#333" strokeWidth="2.5"/>
        {/* フレーム */}
        <line x1="11" y1={rearWheelY} x2="11" y2={frontWheelY} stroke="#555" strokeWidth="2"/>
        <line x1="5"  y1="28" x2="17" y2="28" stroke="#555" strokeWidth="2"/>
        {/* 乗り手 */}
        <circle cx="11" cy={goingAway?20:36} r="4" fill={skinColor}/>
        <rect x="8" y={goingAway?24:28} width="6" height="8" rx="1" fill={bodyColor}/>
        {/* ハンドル */}
        <line x1="6" y1={goingAway?16:40} x2="16" y2={goingAway?16:40} stroke="#444" strokeWidth="2"/>
      </svg>
    );
  }

  // person / child — 45度後方視点の人体
  const w=personW, h=Math.round(personW*4.0);
  const isChild = type==="child";
  const skinColor = isChild ? "#f5c6a0" : "#f5a623";
  const bodyColor = isChild ? "#e74c3c" : "#3498db";
  const goingAway = dir===1;
  // 奥向き=背中、手前向き=正面
  return(
    <svg width={w} height={h} viewBox="0 0 18 72" style={{display:"block"}}>
      {/* 頭 */}
      <circle cx="9" cy="7" r="6" fill={skinColor}/>
      {/* 首 */}
      <rect x="7" y="12" width="4" height="4" fill={skinColor}/>
      {/* 体（胴体） */}
      <rect x="4" y="16" width="10" height="18" rx="2" fill={bodyColor}/>
      {/* 腕（歩行で前後に振る） */}
      <line x1="4"  y1="18" x2={goingAway?1:0}  y2="32" stroke={bodyColor} strokeWidth="3" strokeLinecap="round"/>
      <line x1="14" y1="18" x2={goingAway?17:18} y2="32" stroke={bodyColor} strokeWidth="3" strokeLinecap="round"/>
      {/* 脚（歩行ポーズ） */}
      <line x1="7"  y1="34" x2={goingAway?5:4}  y2="52" stroke={skinColor} strokeWidth="3" strokeLinecap="round"/>
      <line x1="11" y1="34" x2={goingAway?13:14} y2="52" stroke={skinColor} strokeWidth="3" strokeLinecap="round"/>
      {/* 靴 */}
      <ellipse cx={goingAway?5:4}  cy="53" rx="4" ry="2.5" fill="#333"/>
      <ellipse cx={goingAway?13:14} cy="53" rx="4" ry="2.5" fill="#333"/>
      {/* 正面向きの場合は顔を描く */}
      {!goingAway && <>
        <circle cx="6" cy="7" r="1.2" fill="#333"/>
        <circle cx="12" cy="7" r="1.2" fill="#333"/>
        <path d="M6,10 Q9,12 12,10" stroke="#333" strokeWidth="1" fill="none"/>
      </>}
    </svg>
  );
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 道路SVG（実際のpxで正しい一点透視）
// 消失点 = 線路位置（画面中央、bottom=62%）
// 手前(y=H)で幅=W(全幅)、消失点(y=H*0.38)で幅=0に収束
// ─────────────────────────────────────────────
function RoadSVG({ W, H }: { W: number; H: number }) {
  const cx   = W / 2;
  const vpY  = H * (1 - 0.62); // 消失点Y = bottom:62% = H*0.38
  const yBot = H;
  const yFar = vpY + 2;        // 奥端（消失点のすぐ手前）

  // moving car refs and animation
  const pathRef = useRef<SVGPathElement | null>(null);
  const carRef = useRef<SVGGElement | null>(null);
  const lenRef = useRef<number>(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Animation loop: mount once and do not remount on W/H changes
  useEffect(() => {
    const period = 4000; // 4秒で一周

    function step(now: number) {
      if (startRef.current === null) startRef.current = now;
      const t = ((now - startRef.current) / period) % 1; // 0..1 周期
      const pathEl = pathRef.current;
      const carEl = carRef.current;
      if (pathEl && carEl) {
        const len = lenRef.current || (pathEl.getTotalLength && pathEl.getTotalLength());
        try {
          const p = pathEl.getPointAtLength(len * t);
          // 先読みはラップ（ループ対応）
          const next = pathEl.getPointAtLength(len * ((t + 0.01) % 1));
          const angle = Math.atan2(next.y - p.y, next.x - p.x) * 180 / Math.PI;
          carEl.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${angle})`);
        } catch {
          // ignore transient errors
        }
      }
      rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // Keep length up-to-date and observe container (SVG) rather than the <path> itself
  useEffect(() => {
    const pathEl = pathRef.current;
    if (!pathEl) return;
    try { lenRef.current = pathEl.getTotalLength(); } catch {}

    const target = (pathEl.ownerSVGElement as Element) ?? (pathEl as Element);
    const ro = new ResizeObserver(() => {
      try { if (pathEl) lenRef.current = pathEl.getTotalLength(); } catch {}
    });
    ro.observe(target);
    roRef.current = ro;

    // offset-path サポートのプログレッシブエンハンスメント表示
    const supportsOffsetPath = typeof CSS !== "undefined" && typeof (CSS as any).supports === "function" && (CSS as any).supports('offset-distance', '0%');
    if (carRef.current) {
      if (supportsOffsetPath) carRef.current.setAttribute('data-offset-path', 'supported');
      else carRef.current.setAttribute('data-offset-path', 'fallback-js');
    }

    return () => { ro.disconnect(); roRef.current = null; };
  }, [W, H]);

  // y位置での道幅: 手前(yBot)=W*0.9、奥(vpY)=W*0.20 の線形補間
  const roadHalfW = (y: number) => {
    const t = Math.max(0, Math.min(1, (y - vpY) / (yBot - vpY))); // 0=奥, 1=手前
    return W * (0.20 + 0.70 * t) / 2; // 奥20%〜手前90%
  };
  const xL = (y: number) => cx - roadHalfW(y);
  const xR = (y: number) => cx + roadHalfW(y);

  const pts = (arr: [number, number][]) => arr.map(p => p.join(",")).join(" ");

  // センターライン破線（透視的に等間隔）
  const dashLines: { y1: number; y2: number; cx1: number; cx2: number }[] = [];
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const t1 = Math.pow(i / steps, 1.5);
    const t2 = Math.pow((i + 0.45) / steps, 1.5);
    const y1 = yBot - (yBot - yFar) * t1;
    const y2 = yBot - (yBot - yFar) * t2;
    if (y2 >= yFar && y1 <= yBot) {
      // パースに合わせてセンターX（常に cx）
      dashLines.push({ y1, y2, cx1: cx, cx2: cx });
    }
  }

  // 踏切横断帯（線路位置）
  const yRail = vpY + 4;
  const railHW = roadHalfW(yRail);

  return (
    <svg
      className="absolute left-0 top-0 w-full h-full"
      style={{ zIndex: 8, pointerEvents: "none" }}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
    >
      {/* 中心経路（車をパスに沿わせるための参照パス） */}
      <path id="road-center-path" ref={pathRef} d={`M ${W/2} ${H} L ${W/2} ${Math.max(0, H * (1 - 0.62) + 2)}`} fill="none" stroke="transparent" />

      {/* 道路面（台形: 手前=90%幅、奥=20%幅） */}
      <polygon
        points={pts([
          [xL(yBot), yBot],
          [xR(yBot), yBot],
          [xR(yFar), yFar],
          [xL(yFar), yFar],
        ])}
        fill="#4a4a4a"
      />

      {/* 路肩線（左） */}
      <line x1={xL(yBot)} y1={yBot} x2={xL(yFar)} y2={yFar}
        stroke="#e0e0e0" strokeWidth="3" opacity="0.8" />
      {/* 路肩線（右） */}
      <line x1={xR(yBot)} y1={yBot} x2={xR(yFar)} y2={yFar}
        stroke="#e0e0e0" strokeWidth="3" opacity="0.8" />

      {/* センターライン（破線・パース付き） */}
      {dashLines.map((l, i) => (
        <line key={i} x1={l.cx1} y1={l.y1} x2={l.cx2} y2={l.y2}
          stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      ))}

      {/* 踏切横断帯 */}
      <polygon
        points={pts([
          [cx - railHW, yRail + 8],
          [cx + railHW, yRail + 8],
          [cx + railHW, yRail - 8],
          [cx - railHW, yRail - 8],
        ])}
        fill="#5a5a5a" opacity="0.5"
      />

{/* 移動車（非表示・パス追跡用のアンカーとして残す） */}
<g id="moving-car" ref={carRef} transform={`translate(${cx} ${yBot})`} style={{pointerEvents:'none'}}/>
    </svg>
  );
}

// ─────────────────────────────────────────────
// 線路
// ─────────────────────────────────────────────
function Rail(){
  // Draw a double-track: two parallel tracks (each with two rails) with sleepers across
  return(
    <div className="absolute left-0 w-full" style={{top:"62%",height:56,zIndex:10}}>
      {Array.from({length:36}).map((_,i)=>(
        <div key={i} className="absolute"
          style={{left:`${i*2.85}%`,top:0,width:17,height:56,
            background:"linear-gradient(180deg,#7B5230 0%,#5a3a1a 100%)",borderRadius:2}}/>
      ))}
      {/* left track rails */}
      <div className="absolute w-full" style={{top:6,height:6,
        background:"linear-gradient(180deg,#d8d8d8 0%,#a8a8a8 50%,#c8c8c8 100%)",
        boxShadow:"0 2px 5px rgba(0,0,0,0.55)"}}/>
      <div className="absolute w-full" style={{top:18,height:6,
        background:"linear-gradient(180deg,#d8d8d8 0%,#a8a8a8 50%,#c8c8c8 100%)",
        boxShadow:"0 2px 5px rgba(0,0,0,0.55)"}}/>
      {/* right track rails */}
      <div className="absolute w-full" style={{top:32,height:6,
        background:"linear-gradient(180deg,#d8d8d8 0%,#a8a8a8 50%,#c8c8c8 100%)",
        boxShadow:"0 2px 5px rgba(0,0,0,0.55)"}}/>
      <div className="absolute w-full" style={{top:44,height:6,
        background:"linear-gradient(180deg,#d8d8d8 0%,#a8a8a8 50%,#c8c8c8 100%)",
        boxShadow:"0 2px 5px rgba(0,0,0,0.55)"}}/>
    </div>
  );
}

// ─────────────────────────────────────────────
// 電車
// ─────────────────────────────────────────────
function TrainSVG({def,smokeFrame,fromLeft,yRail}:{def:TrainDef;smokeFrame:number;fromLeft:boolean;yRail:number}){
  // Train vertical alignment based on the rail container defined in `Rail()`.
  // Rail container: top = H * 0.62, height = 56. We receive `yRail` as container center (top + 28).
  const TRAIN_HEIGHT = 88; // SVG train graphic height
  const containerHalf = 28; // half of rail container height
  const containerTop = yRail - containerHalf;
  const upperTrackCenter = containerTop + 12; // upper track center (top track)
  const lowerTrackCenter = containerTop + 38; // lower track center (bottom track)
  const trackSpacing = lowerTrackCenter - upperTrackCenter;

  // Position rules:
  // - fromLeft (left->right): place one track-spacing above the right->left position
  // - !fromLeft (right->left): place at upperTrackCenter (top track)
  const targetCenter = fromLeft ? (upperTrackCenter - trackSpacing) : upperTrackCenter;
  const topPx = Math.round(targetCenter - TRAIN_HEIGHT / 2);
  const cls = fromLeft ? "absolute train-running" : "absolute train-running train-running--rtl";
  const varKey = "--train-speed";
  return (
    <div className={cls} style={{top: `${topPx}px`, left: 0, zIndex: 20, [varKey]: `${def.speed}s`}}>
      <div style={{transform: fromLeft ? 'none' : 'scaleX(-1)'}}>
        {def.id==="shinkansen" && <Shinkansen def={def}/>}
        {def.id==="express"    && <Express def={def}/>}
        {def.id==="steam"      && <SteamLoco def={def} smokeFrame={smokeFrame}/>}
        {def.id==="local"      && <LocalTrain def={def}/>}
      </div>
    </div>
  );
}

function LocalTrain({def}:{def:TrainDef}){
  return(
    <svg width="420" height="88" viewBox="0 0 420 88">
      {/* 後続車両 */}
      <rect x="2" y="4" width="195" height="70" rx="6" fill={def.color1}/>
      <rect x="2" y="4" width="195" height="18" rx="6" fill={def.color2}/>
      <rect x="2" y="4" width="195" height="4" rx="2" fill="#fff" opacity="0.15"/>
      {/* 帯 */}
      <rect x="2" y="44" width="195" height="5" fill={def.accent} opacity="0.8"/>
      {/* 窓 */}
      {[16,52,88,124,160].map(x=>(
        <g key={x}>
          <rect x={x} y="14" width="26" height="22" rx="3" fill={def.accent} stroke={def.color2} strokeWidth="1.5"/>
          <rect x={x+2} y="14" width="8" height="22" rx="2" fill="rgba(255,255,255,0.2)"/>
        </g>
      ))}
      {/* ドア */}
      <rect x="42" y="48" width="22" height="26" rx="2" fill={def.color2}/>
      <rect x="108" y="48" width="22" height="26" rx="2" fill={def.color2}/>
      {/* 先頭車両 */}
      <rect x="202" y="4" width="195" height="70" rx="6" fill={def.color1}/>
      <rect x="202" y="4" width="195" height="18" rx="6" fill={def.color2}/>
      <rect x="202" y="4" width="195" height="4" rx="2" fill="#fff" opacity="0.15"/>
      <rect x="202" y="44" width="195" height="5" fill={def.accent} opacity="0.8"/>
      {/* 先頭フェイス */}
      <path d="M370 4 Q415 4 415 34 L415 74 L370 74 Z" fill={def.color1}/>
      <path d="M370 4 Q415 4 415 14 L415 4 Z" fill={def.color2}/>
      {[218,254,290].map(x=>(
        <g key={x}>
          <rect x={x} y="14" width="26" height="22" rx="3" fill={def.accent} stroke={def.color2} strokeWidth="1.5"/>
          <rect x={x+2} y="14" width="8" height="22" rx="2" fill="rgba(255,255,255,0.2)"/>
        </g>
      ))}
      <rect x="242" y="48" width="22" height="26" rx="2" fill={def.color2}/>
      <rect x="330" y="48" width="22" height="26" rx="2" fill={def.color2}/>
      {/* ヘッドライト */}
      <rect x="400" y="56" width="13" height="9" rx="2" fill="#fffaaa"/>
      <rect x="400" y="56" width="13" height="9" rx="2" fill="none" stroke="#ccc" strokeWidth="0.5"/>
      {/* 車輪 */}
      {[18,60,115,158,215,260,315,358].map(x=>(
        <g key={x}>
          <circle cx={x+9} cy="78" r="10" fill="#1a1a1a" stroke="#666" strokeWidth="2"/>
          <circle cx={x+9} cy="78" r="5" fill="#333"/>
          <line x1={x+9} y1="68" x2={x+9} y2="88" stroke="#555" strokeWidth="1.5"/>
          <line x1={x} y1="78" x2={x+18} y2="78" stroke="#555" strokeWidth="1.5"/>
        </g>
      ))}
      {/* パンタグラフ */}
      <line x1="300" y1="4" x2="294" y2="-16" stroke="#888" strokeWidth="2"/>
      <line x1="306" y1="4" x2="312" y2="-16" stroke="#888" strokeWidth="2"/>
      <line x1="278" y1="-16" x2="328" y2="-16" stroke="#888" strokeWidth="2.5"/>
    </svg>
  );
}

function Express({def}:{def:TrainDef}){
  return(
    <svg width="460" height="88" viewBox="0 0 460 88">
      {/* 後続 */}
      <rect x="2" y="6" width="215" height="66" rx="5" fill={def.color1}/>
      <rect x="2" y="6" width="215" height="14" rx="5" fill={def.color2}/>
      <rect x="2" y="42" width="215" height="6" fill="#ffcc00"/>
      <rect x="2" y="50" width="215" height="3" fill="#ffcc00" opacity="0.5"/>
      {[14,56,98,140,182].map(x=>(
        <g key={x}>
          <rect x={x} y="14" width="28" height="20" rx="2" fill={def.accent} stroke={def.color2} strokeWidth="1.5"/>
          <rect x={x+2} y="14" width="8" height="20" rx="1" fill="rgba(255,255,255,0.18)"/>
        </g>
      ))}
      <rect x="40" y="52" width="24" height="20" rx="2" fill={def.color2}/>
      <rect x="120" y="52" width="24" height="20" rx="2" fill={def.color2}/>
      {/* 先頭 */}
      <rect x="222" y="6" width="210" height="66" rx="5" fill={def.color1}/>
      <rect x="222" y="6" width="210" height="14" rx="5" fill={def.color2}/>
      <rect x="222" y="42" width="210" height="6" fill="#ffcc00"/>
      <path d="M405 6 Q456 6 456 36 L456 72 L405 72 Z" fill={def.color1}/>
      <path d="M405 6 Q456 6 456 16 L456 6 Z" fill={def.color2}/>
      {[238,280,322].map(x=>(
        <g key={x}>
          <rect x={x} y="14" width="28" height="20" rx="2" fill={def.accent} stroke={def.color2} strokeWidth="1.5"/>
          <rect x={x+2} y="14" width="8" height="20" rx="1" fill="rgba(255,255,255,0.18)"/>
        </g>
      ))}
      <rect x="440" y="56" width="14" height="10" rx="2" fill="#fffaaa"/>
      {[18,65,122,170,228,278,332,382].map(x=>(
        <g key={x}>
          <circle cx={x+9} cy="78" r="10" fill="#1a1a1a" stroke="#666" strokeWidth="2"/>
          <circle cx={x+9} cy="78" r="5" fill="#333"/>
        </g>
      ))}
      <line x1="335" y1="6" x2="329" y2="-14" stroke="#888" strokeWidth="2"/>
      <line x1="341" y1="6" x2="347" y2="-14" stroke="#888" strokeWidth="2"/>
      <line x1="313" y1="-14" x2="363" y2="-14" stroke="#888" strokeWidth="2.5"/>
    </svg>
  );
}

function Shinkansen({def}:{def:TrainDef}){
  return(
    <svg width="560" height="88" viewBox="0 0 560 88">
      {/* 後続 */}
      <rect x="2" y="10" width="250" height="60" rx="5" fill={def.color1}/>
      <rect x="2" y="10" width="250" height="10" rx="5" fill={def.accent}/>
      <rect x="2" y="54" width="250" height="8" fill={def.accent}/>
      <rect x="2" y="10" width="250" height="3" fill="rgba(255,255,255,0.3)"/>
      {[14,64,114,164,214].map(x=>(
        <g key={x}>
          <rect x={x} y="20" width="36" height="22" rx="3" fill="#d8eeff" stroke="#bbb" strokeWidth="1"/>
          <rect x={x+2} y="20" width="10" height="22" rx="2" fill="rgba(255,255,255,0.25)"/>
        </g>
      ))}
      {/* 先頭（流線型） */}
      <path d="M258 10 L470 10 Q558 10 558 42 L558 70 L258 70 Z" fill={def.color1}/>
      <path d="M258 10 L470 10 Q558 10 558 20 L558 10 Z" fill={def.accent}/>
      <path d="M258 54 L558 54 L558 62 L258 62 Z" fill={def.accent}/>
      <path d="M258 10 L558 10 L558 13 L258 13 Z" fill="rgba(255,255,255,0.3)"/>
      {[272,322,372,422].map(x=>(
        <g key={x}>
          <rect x={x} y="20" width="36" height="22" rx="3" fill="#d8eeff" stroke="#bbb" strokeWidth="1"/>
          <rect x={x+2} y="20" width="10" height="22" rx="2" fill="rgba(255,255,255,0.25)"/>
        </g>
      ))}
      {/* ノーズライト */}
      <ellipse cx="554" cy="64" rx="7" ry="5" fill="#fffaaa"/>
      {/* 車輪 */}
      {[20,78,145,202,268,325,390,448].map(x=>(
        <g key={x}>
          <circle cx={x+9} cy="76" r="9" fill="#444" stroke="#888" strokeWidth="2"/>
          <circle cx={x+9} cy="76" r="4" fill="#666"/>
        </g>
      ))}
      {/* パンタグラフ */}
      <line x1="392" y1="10" x2="386" y2="-10" stroke="#aaa" strokeWidth="2"/>
      <line x1="398" y1="10" x2="404" y2="-10" stroke="#aaa" strokeWidth="2"/>
      <line x1="370" y1="-10" x2="420" y2="-10" stroke="#aaa" strokeWidth="2.5"/>
    </svg>
  );
}

function SteamLoco({def,smokeFrame}:{def:TrainDef;smokeFrame:number}){
  // 煙: smokeFrameで揺れる複数の円
  const smokes = [
    {cx:0,  cy:-smokeFrame*0.4-8,  r:8+smokeFrame*0.15, op:Math.max(0,0.7-smokeFrame*0.012)},
    {cx:4,  cy:-smokeFrame*0.5-18, r:10+smokeFrame*0.12, op:Math.max(0,0.55-smokeFrame*0.01)},
    {cx:-3, cy:-smokeFrame*0.45-28,r:12+smokeFrame*0.1,  op:Math.max(0,0.4-smokeFrame*0.009)},
    {cx:5,  cy:-smokeFrame*0.5-40, r:14+smokeFrame*0.08, op:Math.max(0,0.25-smokeFrame*0.007)},
  ];
  return(
    <svg width="400" height="100" viewBox="0 0 400 100" style={{overflow:"visible"}}>
      {/* 煙 */}
      <g transform="translate(348,8)">
        {smokes.map((s,i)=>(
          <circle key={i} cx={s.cx} cy={s.cy} r={s.r}
            fill="#aaa" opacity={s.op}/>
        ))}
      </g>
      {/* 炭水車 */}
      <rect x="2" y="24" width="135" height="54" rx="4" fill="#3a3a3a"/>
      <rect x="8" y="30" width="123" height="24" rx="3" fill="#222"/>
      <rect x="8" y="56" width="123" height="10" rx="2" fill="#444"/>
      {/* 機関車本体 */}
      <rect x="145" y="28" width="210" height="48" rx="5" fill={def.color1}/>
      {/* ボイラー */}
      <ellipse cx="308" cy="46" rx="68" ry="26" fill="#181818"/>
      <ellipse cx="308" cy="46" rx="63" ry="22" fill="#222"/>
      {/* ボイラーバンド */}
      {[252,278,304,330].map(x=>(
        <line key={x} x1={x} y1="24" x2={x} y2="68" stroke="#2a2a2a" strokeWidth="2.5"/>
      ))}
      {/* 煙突 */}
      <rect x="342" y="4" width="20" height="28" rx="4" fill="#111"/>
      <ellipse cx="352" cy="4" rx="15" ry="7" fill="#2a2a2a"/>
      <ellipse cx="352" cy="4" rx="12" ry="5" fill="#333"/>
      {/* ドーム */}
      <ellipse cx="290" cy="26" rx="22" ry="13" fill="#1a1a1a"/>
      <ellipse cx="290" cy="26" rx="18" ry="10" fill="#252525"/>
      {/* 安全弁 */}
      <rect x="268" y="14" width="6" height="12" rx="2" fill="#555"/>
      {/* キャブ */}
      <rect x="145" y="16" width="72" height="60" rx="4" fill={def.accent}/>
      <rect x="145" y="16" width="72" height="8" rx="4" fill="#aa3300"/>
      {/* キャブ窓 */}
      <rect x="155" y="24" width="24" height="20" rx="3" fill="#c8e8ff" stroke="#333" strokeWidth="1.5"/>
      <rect x="183" y="24" width="24" height="20" rx="3" fill="#c8e8ff" stroke="#333" strokeWidth="1.5"/>
      {/* 前面ライト */}
      <circle cx="386" cy="56" r="10" fill="#fffaaa" stroke="#888" strokeWidth="2"/>
      <circle cx="386" cy="56" r="6" fill="#fff8cc"/>
      {/* 連結棒 */}
      <rect x="160" y="68" width="225" height="5" rx="2.5" fill="#cc4400"/>
      {/* 大車輪 */}
      {[170,222,274,326].map(x=>(
        <g key={x}>
          <circle cx={x} cy="80" r="16" fill="#111" stroke="#555" strokeWidth="3"/>
          <circle cx={x} cy="80" r="8" fill="#1a1a1a"/>
          {[0,60,120,180,240,300].map(deg=>(
            <line key={deg}
              x1={x+8*Math.cos(deg*Math.PI/180)} y1={80+8*Math.sin(deg*Math.PI/180)}
              x2={x+16*Math.cos(deg*Math.PI/180)} y2={80+16*Math.sin(deg*Math.PI/180)}
              stroke="#333" strokeWidth="2.5"/>
          ))}
          <circle cx={x} cy="80" r="3" fill="#555"/>
        </g>
      ))}
      {/* 炭水車小車輪 */}
      {[24,68,112].map(x=>(
        <g key={x}>
          <circle cx={x} cy="82" r="11" fill="#1a1a1a" stroke="#555" strokeWidth="2"/>
          <circle cx={x} cy="82" r="5" fill="#2a2a2a"/>
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────
// 踏切構造物（画像に忠実）
// ─────────────────────────────────────────────
function FumikiriStructure({barrierAngle,isWarning,W,H,trainFromLeft}:{barrierAngle:number;isWarning:boolean;W:number;H:number;trainFromLeft:boolean}){
  // Rail は top:"62%" = H*0.62 の位置
  const cx    = W / 2;
  const yRail = H * 0.62 + 28; // 線路の中央Y（top:62% + 高さ56の中央）
  // RoadSVGと同じ道路幅計算: 消失点vpY=H*0.38、手前=H
  const vpY   = H * 0.38;
  const t = Math.max(0, Math.min(1, (yRail - vpY) / (H - vpY)));
  const railHalfW = W * (0.20 + 0.70 * t) / 2;
  const roadLeftX  = cx - railHalfW;
  const roadRightX = cx + railHalfW;
  const roadW = railHalfW * 2;

  // ポールの高さは画面高さの15%に固定（バー長とは独立）
  const BASE_BLEN = 180;
  const poleScale = (H * 0.15) / 220; // pH=220 を基準にポール高さをスケール
  const barScale  = roadW / BASE_BLEN; // バー長のスケール（道路幅に合わせる）
  const pH = 220;
  const scaledH = (pH + 35) * poleScale;

  // 全体の高さをウインドウ高さの 1/3 にするための追加スケール
  const targetHeight = H / 3;
  const overallScale = Math.max(0.01, targetHeight / scaledH);

  // ポールのtop: 線路Y - スケール後の構造物高さ
  const poleTop = yRail - scaledH * overallScale;
  // ポールのleft: ポール中心(SVG内x=34)をpoleScaleした分オフセット
  const poleOffsetX = 34 * poleScale;
  const wrapperWidth = roadW / overallScale + 80 * poleScale;
  const wrapperHeight = scaledH;

  return(
    <div className="absolute" style={{
      left: roadLeftX - poleOffsetX,
      top: poleTop,
      width: wrapperWidth,
      height: wrapperHeight,
      transform: `scale(${overallScale})`,
      transformOrigin: "top left",
      zIndex: 30,
    }}>
      <div className="absolute" style={{left:0, top:0}}>
        <FumikiriPole isWarning={isWarning} barrierAngle={barrierAngle} side="left" bLen={roadW} poleScale={poleScale} overallScale={overallScale} trainFromLeft={trainFromLeft}/>
      </div>
      <div className="absolute" style={{left: roadW / overallScale, top:0}}>
        <FumikiriPole isWarning={isWarning} barrierAngle={barrierAngle} side="right" bLen={roadW} poleScale={poleScale} overallScale={overallScale} trainFromLeft={trainFromLeft}/>
      </div>
    </div>
  );
}

function FumikiriPole({isWarning,barrierAngle,side,bLen,poleScale,overallScale,trainFromLeft}:{isWarning:boolean;barrierAngle:number;side:"left"|"right";bLen:number;poleScale:number;overallScale:number;trainFromLeft:boolean}){
  const pH=220;
  const angle = side==="left" ? barrierAngle : -barrierAngle;
  // SVG内でのバー長: 道路幅を全体スケールとポールスケールで割った値にする
  const svgBarLen = bLen / poleScale / overallScale;

  return(
    <svg
      width={80 * poleScale} height={(pH+35) * poleScale}
      viewBox={`0 0 80 ${pH+35}`}
      style={{overflow:"visible", display:"block"}}
    >
      {/* コンクリート台座 */}
      <rect x="8"  y={pH+2}  width="48" height="22" rx="6" fill="#b0b0b0"/>
      <rect x="4"  y={pH+18} width="56" height="14" rx="5" fill="#909090"/>
      <rect x="10" y={pH+2}  width="44" height="5"  rx="2" fill="#c8c8c8"/>

      {/* ポール本体（黒黄ストライプ・太め） */}
      {Array.from({length:12}).map((_,i)=>(
        <rect key={i} x="26" y={i*18} width="16" height="18"
          fill={i%2===0?"#1a1a1a":"#f5c800"}/>
      ))}
      {/* ポール輪郭 */}
      <rect x="26" y="0" width="16" height={pH} rx="3" fill="none" stroke="#333" strokeWidth="1.5"/>

      {/* ===== X字踏切標識（上部・大きめ） ===== */}
      <g transform="translate(34,32)">
        {/* X棒1（左上→右下）黒黄ストライプ */}
        <g transform="rotate(-42)">
          <clipPath id={`cp1-${side}`}>
            <rect x="-28" y="-7" width="56" height="14" rx="6"/>
          </clipPath>
          <rect x="-28" y="-7" width="56" height="14" rx="6" fill="#1a1a1a" clipPath={`url(#cp1-${side})`}/>
          {[0,1,2,3,4].map(i=>(
            <rect key={i} x={-28+i*11+5} y="-7" width="6" height="14"
              fill="#f5c800" clipPath={`url(#cp1-${side})`}/>
          ))}
          <rect x="-28" y="-7" width="56" height="14" rx="6" fill="none" stroke="#1a1a1a" strokeWidth="2"/>
        </g>
        {/* X棒2（右上→左下） */}
        <g transform="rotate(42)">
          <clipPath id={`cp2-${side}`}>
            <rect x="-28" y="-7" width="56" height="14" rx="6"/>
          </clipPath>
          <rect x="-28" y="-7" width="56" height="14" rx="6" fill="#1a1a1a" clipPath={`url(#cp2-${side})`}/>
          {[0,1,2,3,4].map(i=>(
            <rect key={i} x={-28+i*11+5} y="-7" width="6" height="14"
              fill="#f5c800" clipPath={`url(#cp2-${side})`}/>
          ))}
          <rect x="-28" y="-7" width="56" height="14" rx="6" fill="none" stroke="#1a1a1a" strokeWidth="2"/>
        </g>
        {/* 中央ボルト */}
        <circle cx="0" cy="0" r="6" fill="#333" stroke="#555" strokeWidth="1.5"/>
        <circle cx="0" cy="0" r="2" fill="#666"/>
      </g>

      {/* ===== 警告灯ユニット ===== */}
      {/* アーム（左右に張り出す） */}
      <line x1="34" y1="68" x2="6"  y2="80" stroke="#1a1a1a" strokeWidth="4"/>
      <line x1="34" y1="68" x2="62" y2="80" stroke="#1a1a1a" strokeWidth="4"/>
      {/* 灯体ボックス */}
      <rect x="-8"  y="72" width="28" height="20" rx="4" fill="#1a1a1a" stroke="#333" strokeWidth="1.5"/>
      <rect x="44"  y="72" width="28" height="20" rx="4" fill="#1a1a1a" stroke="#333" strokeWidth="1.5"/>
      {/* 左灯 */}
      <circle cx="6"  cy="82" r="11" fill="#111" stroke="#222" strokeWidth="1.5"/>
      <circle cx="6"  cy="82" r="9"
        fill={isWarning?undefined:"#3a0000"}
        className={isWarning?"light-on":undefined}/>
      <circle cx="6"  cy="82" r="4" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
      {/* 右灯 */}
      <circle cx="62" cy="82" r="11" fill="#111" stroke="#222" strokeWidth="1.5"/>
      <circle cx="62" cy="82" r="9"
        fill={isWarning?undefined:"#3a0000"}
        className={isWarning?"light-inv":undefined}/>
      <circle cx="62" cy="82" r="4" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>

      {/* ===== 方向指示板 ===== */}
      <rect x="18" y="96" width="32" height="24" rx="4" fill="#1a1a1a" stroke="#333" strokeWidth="1.5"/>
      <rect x="20" y="98" width="28" height="10" rx="2" fill="#111"/>
      <rect x="20" y="110" width="28" height="8"  rx="2" fill="#111"/>
      {/* 矢印: 実際の進行方向のみ赤にする */}
      <text x="34" y="107" textAnchor="middle" fontSize="9" fontWeight="bold"
        fill={isWarning && trainFromLeft ? "#ff2200" : "#550000"}>→</text>
      <text x="34" y="117" textAnchor="middle" fontSize="9" fontWeight="bold"
        fill={isWarning && !trainFromLeft ? "#ff2200" : "#550000"}>←</text>

      {/* ===== 遮断機 ===== */}
      <g style={{
        transform:`rotate(${angle}deg)`,
        transformOrigin:"34px 124px",
        transition:"transform 1.6s ease-in-out",
      }}>
        {/* メインバー（黒黄ストライプ） */}
        {Array.from({length:Math.ceil(svgBarLen/22)}).map((_,i)=>(
          <rect key={i}
            x={side==="left"? 34+i*22 : 34-(i+1)*22}
            y="119" width="22" height="12"
            fill={i%2===0?"#1a1a1a":"#f5c800"}/>
        ))}
        <rect x={side==="left"?34:34-svgBarLen} y="119"
          width={svgBarLen} height="12" rx="3"
          fill="none" stroke="#1a1a1a" strokeWidth="2"/>
        {/* バー上面ハイライト */}
        <rect x={side==="left"?34:34-svgBarLen} y="119"
          width={svgBarLen} height="3" rx="2"
          fill="rgba(255,255,255,0.15)"/>

        {/* 垂れ下がり（赤白ストライプ棒） */}
        {Array.from({length:8}).map((_,i)=>{
          const bx = side==="left" ? 34+24+i*22 : 34-24-i*22;
          return(
            <g key={i}>
              <rect x={bx-4} y="131" width="8" height="30" rx="3" fill="#fff" stroke="#ddd" strokeWidth="0.5"/>
              {[0,1,2,3].map(j=>(
                <rect key={j} x={bx-4} y={131+j*7.5} width="8" height="7.5"
                  fill={j%2===0?"#e8001a":"#fff"}/>
              ))}
              <rect x={bx-4} y="131" width="8" height="30" rx="3" fill="none" stroke="#ccc" strokeWidth="0.5"/>
            </g>
          );
        })}
        {/* 先端ウェイト */}
        <rect x={side==="left"?34+svgBarLen-22:34-svgBarLen} y="115" width="22" height="20" rx="3"
          fill="#1a1a1a" stroke="#f5c800" strokeWidth="2.5"/>
        <rect x={side==="left"?34+svgBarLen-22:34-svgBarLen} y="115" width="22" height="5" rx="2"
          fill="#f5c800" opacity="0.6"/>
      </g>
    </svg>
  );
}

// ─────────────────────────────────────────────
// フェーズラベル
// ─────────────────────────────────────────────
function PhaseLabel({phase}:{phase:Phase}){
  const labels:Record<Phase,string>={
    idle:"🟢 ふみきり あいてるよ", warning:"🔴 でんしゃが くるよ！",
    closed:"🚧 とおれません！", passing:"🚃 でんしゃ つうかちゅう！",
    opening:"🟡 もうすぐ あくよ", done:"✅ とおれるよ！",
  };
  const colors:Record<Phase,string>={
    idle:"#27ae60", warning:"#e74c3c", closed:"#c0392b",
    passing:"#2980b9", opening:"#f39c12", done:"#27ae60",
  };
  return(
    <div className="absolute top-4 left-1/2 -translate-x-1/2 px-6 py-2 rounded-full text-white text-lg font-bold shadow-lg"
      style={{background:colors[phase],textShadow:"1px 1px 2px rgba(0,0,0,0.4)",transition:"background 0.5s",zIndex:50}}>
      {labels[phase]}
    </div>
  );
}

// ─────────────────────────────────────────────
// ゴジラSVG（提供SVGコード使用・中央固定・巨大）
// ─────────────────────────────────────────────
import { godzillaSVGInner } from "../components/GodzillaSVGPaths";

function GodzillaSVG({heatRay}:{heatRay:boolean}){
  void heatRay;
  return(
    <div className="absolute inset-0 flex items-center justify-center" style={{zIndex:200, pointerEvents:"none"}}>
      <svg
        viewBox="0 0 1024 892"
        preserveAspectRatio="xMidYMid meet"
        style={{display:"block", maxWidth:"90vw", maxHeight:"90vh", width:"auto", height:"auto", pointerEvents:"none"}}
        dangerouslySetInnerHTML={{__html: godzillaSVGInner}}
      />
    </div>
  );
}
