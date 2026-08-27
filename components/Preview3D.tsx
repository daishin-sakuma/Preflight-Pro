'use client';

// 3D rotatable paper preview (graphic-style): the finished (trimmed) piece
// rendered onto a thin sheet you can drag-rotate / zoom, with front/back,
// selectable paper finish (gloss / matte / uncoated) and fold simulation
// (half fold / Z fold with an adjustable opening angle).

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Center } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface ViewCommand { cmd: 'front' | 'back' | 'reset'; n: number }
export type PaperFinish = 'gloss' | 'matte' | 'uncoated';
export type FoldMode = 'none' | 'half' | 'z' | 'tri';

interface Props {
  front: HTMLCanvasElement;
  back?: HTMLCanvasElement | null;
  wMm: number;
  hMm: number;
  autoRotate: boolean;
  command: ViewCommand;
  stageColor?: string;   // pasteboard colour (theme-dependent)
  finish?: PaperFinish;  // paper surface material
  fold?: FoldMode;       // fold simulation
  foldAngle?: number;    // opening angle in degrees (180 = flat)
  onFacing?: (facing: 'front' | 'back') => void; // which face is toward the camera
  // lets the page drive zoom in/out + fit (shared keyboard shortcuts with 2D)
  controlRef?: React.MutableRefObject<Zoom3DApi | null>;
}

// paper surface parameters per finish (meshPhysicalMaterial)
const FINISH: Record<PaperFinish, { roughness: number; clearcoat: number; clearcoatRoughness: number }> = {
  gloss: { roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.22 },
  matte: { roughness: 0.82, clearcoat: 0.06, clearcoatRoughness: 0.6 },
  uncoated: { roughness: 0.96, clearcoat: 0, clearcoatRoughness: 1 },
};
const EDGE = '#e8e8e6';
const SHEET_T = 0.035;

const makeTex = (src: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(src);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

function Paper({ front, back, wMm, hMm, finish }: {
  front: HTMLCanvasElement; back?: HTMLCanvasElement | null;
  wMm: number; hMm: number; finish: PaperFinish;
}) {
  const frontTex = useMemo(() => makeTex(front), [front]);
  const backTex = useMemo(() => (back ? makeTex(back) : null), [back]);
  useEffect(() => () => { frontTex.dispose(); backTex?.dispose(); }, [frontTex, backTex]);

  // scale: fit long edge to ~10 scene units
  const long = Math.max(wMm, hMm);
  const w = (wMm / long) * 10;
  const h = (hMm / long) * 10;
  const fp = FINISH[finish];

  return (
    <mesh castShadow>
      <boxGeometry args={[w, h, SHEET_T]} />
      {/* +x -x +y -y +z(front) -z(back) */}
      <meshPhysicalMaterial attach="material-0" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-1" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-2" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-3" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-4" map={frontTex} roughness={fp.roughness}
        clearcoat={fp.clearcoat} clearcoatRoughness={fp.clearcoatRoughness} />
      {backTex
        ? <meshPhysicalMaterial attach="material-5" map={backTex} roughness={fp.roughness}
            clearcoat={fp.clearcoat} clearcoatRoughness={fp.clearcoatRoughness} />
        : <meshPhysicalMaterial attach="material-5" color="#fbfbf9" roughness={0.9} />}
    </mesh>
  );
}

// Folded sheet: the front artwork is split into vertical panels linked by a
// hinge chain. Fold directions alternate for half / Z folds; for the triangle
// fold (三つ折りを三角柱に閉じる) every hinge folds the same way, so at a 60°
// opening angle the three equal panels close into a triangular prism with the
// artwork facing outward. The back face of each panel shows the corresponding
// region of the back page: viewed from behind, front panel i lines up with
// back-canvas strip (panels-1-i) — for the triangle fold that back face ends
// up inside the prism, exactly like the physical piece.
function FoldedPaper({ front, back, wMm, hMm, panels, angleDeg, sameSide, finish }: {
  front: HTMLCanvasElement; back?: HTMLCanvasElement | null;
  wMm: number; hMm: number; panels: number; angleDeg: number;
  sameSide: boolean; finish: PaperFinish;
}) {
  const parts = useMemo(() => {
    const strip = (src: HTMLCanvasElement, stripIdx: number) => {
      const pw = Math.max(1, Math.floor(src.width / panels));
      const c = document.createElement('canvas');
      c.width = pw; c.height = src.height;
      c.getContext('2d')!.drawImage(src, stripIdx * pw, 0, pw, src.height, 0, 0, pw, src.height);
      return makeTex(c);
    };
    return Array.from({ length: panels }, (_, i) => ({
      front: strip(front, i),
      back: back ? strip(back, panels - 1 - i) : null,
    }));
  }, [front, back, panels]);
  useEffect(() => () => { parts.forEach((p) => { p.front.dispose(); p.back?.dispose(); }); }, [parts]);

  const long = Math.max(wMm, hMm);
  const w = (wMm / long) * 10;
  const h = (hMm / long) * 10;
  const pw = w / panels;
  // same-side hinges can't fold past the closed triangle (60° interior angle)
  const angle = sameSide ? Math.max(60, angleDeg) : angleDeg;
  const foldRot = ((180 - angle) * Math.PI) / 180;
  const fp = FINISH[finish];

  const panelMesh = (i: number) => (
    <mesh castShadow position={[pw / 2, 0, 0]}>
      <boxGeometry args={[pw, h, SHEET_T]} />
      <meshPhysicalMaterial attach="material-0" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-1" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-2" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-3" color={EDGE} roughness={0.9} />
      <meshPhysicalMaterial attach="material-4" map={parts[i].front} roughness={fp.roughness}
        clearcoat={fp.clearcoat} clearcoatRoughness={fp.clearcoatRoughness} />
      {parts[i].back
        ? <meshPhysicalMaterial attach="material-5" map={parts[i].back} roughness={fp.roughness}
            clearcoat={fp.clearcoat} clearcoatRoughness={fp.clearcoatRoughness} />
        : <meshPhysicalMaterial attach="material-5" color="#fbfbf9" roughness={0.9} />}
    </mesh>
  );

  // hinge chain: panel i's group sits at the right edge of panel i-1 and
  // rotates around that vertical edge. Alternating signs make a half / Z fold;
  // a constant positive sign bends the chain backwards into the triangle with
  // the front (+z, artwork) faces on the outside.
  const build = (i: number): React.ReactElement | null => {
    if (i >= panels) return null;
    const rot = i === 0 ? 0 : sameSide ? foldRot : (i % 2 === 1 ? -foldRot : foldRot);
    return (
      <group position={i === 0 ? [-w / 2, 0, 0] : [pw, 0, 0]} rotation={[0, rot, 0]}>
        {panelMesh(i)}
        {build(i + 1)}
      </group>
    );
  };

  // <Center> recenters the folded assembly; key forces a re-measure when the
  // fold shape changes
  return <Center key={`${panels}:${sameSide}:${Math.round(angle)}`}>{build(0)}</Center>;
}

const MIN_DIST = 4;
const MAX_DIST = 80;

export interface Zoom3DApi { zoomIn(): void; zoomOut(): void; reset(): void }

function Rig({ autoRotate, command, wMm, hMm, onFacing, onZoomPct, apiRef }: {
  autoRotate: boolean; command: ViewCommand; wMm: number; hMm: number;
  onFacing?: (facing: 'front' | 'back') => void;
  onZoomPct?: (pct: number) => void;
  apiRef?: React.MutableRefObject<Zoom3DApi | null>;
}) {
  const { camera, size } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const lastFacing = useRef<'front' | 'back' | null>(null);
  const lastPct = useRef(0);
  const anim = useRef<{
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromLook: THREE.Vector3; toLook: THREE.Vector3; t: number;
  } | null>(null);
  const mounted = useRef(false);

  // scene units of the sheet (mirrors <Paper/>: long edge = 10 units)
  const long = Math.max(wMm, hMm);
  const wUnits = (wMm / long) * 10;
  const hUnits = (hMm / long) * 10;

  // distance at which the whole sheet fits the frustum (both axes) with margin
  const fitDist = useMemo(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const vfov = (cam.fov * Math.PI) / 180;
    const aspect = size.width / Math.max(1, size.height);
    const margin = 1.22; // padding + allowance for the tilted (3/4) view
    const fitH = (hUnits * margin) / 2 / Math.tan(vfov / 2);
    const fitW = (wUnits * margin) / 2 / (Math.tan(vfov / 2) * aspect);
    return Math.max(fitH, fitW, 6);
  }, [wUnits, hUnits, camera, size]);

  const ORIGIN = new THREE.Vector3(0, 0, 0);
  const ctrlTarget = () => (controls.current ? controls.current.target.clone() : ORIGIN.clone());

  const targetFor = (cmd: ViewCommand['cmd']): THREE.Vector3 => {
    // 'reset' (also the default framing) = straight-on front, whole piece centered
    if (cmd === 'back') return new THREE.Vector3(0, 0, -fitDist);
    return new THREE.Vector3(0, 0, fitDist);
  };

  // Smoothly tween camera position AND the orbit target (look-at point). Tweening
  // the target too is essential: OrbitControls' target may have been panned away
  // from the origin, and if we only moved the camera it would snap to the stale
  // target when control resumes. Also resets leftover orbit inertia.
  const animateTo = (toPos: THREE.Vector3, toLook: THREE.Vector3) => {
    const c = controls.current;
    if (c) {
      c.enableDamping = false; c.update(); c.enableDamping = true; // flush leftover inertia
      c.enabled = false;                                           // lock input during tween
    }
    anim.current = {
      fromPos: camera.position.clone(), toPos: toPos.clone(),
      fromLook: ctrlTarget(), toLook: toLook.clone(), t: 0,
    };
  };

  const place = (cmd: ViewCommand['cmd'], animate = false) => {
    const target = targetFor(cmd);
    if (animate) { animateTo(target, ORIGIN.clone()); return; }
    anim.current = null;
    camera.position.copy(target);
    const c = controls.current;
    if (c) c.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    c?.update();
  };

  // explicit front/back/reset commands (animate after first mount)
  useEffect(() => { place(command.cmd, mounted.current); mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // default framing: fit on mount / viewport-or-sheet size change (instant)
  useEffect(() => { place('reset'); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitDist]);

  useFrame((_, delta) => {
    // camera tween (Fit / zoom buttons) — eased, ~0.3s, then stop
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + delta / 0.3);
      const e = 1 - Math.pow(1 - a.t, 3); // easeOutCubic
      camera.position.lerpVectors(a.fromPos, a.toPos, e);
      const look = a.fromLook.clone().lerp(a.toLook, e);
      const c = controls.current;
      if (c) c.target.copy(look);
      camera.lookAt(look);
      if (a.t >= 1) {
        anim.current = null;
        if (c) { c.target.copy(a.toLook); c.enabled = true; c.update(); } // sync, no snap
      }
    }
    // report facing (page indicator) + zoom % (100% = fit distance); live
    const facing = camera.position.z >= 0 ? 'front' : 'back';
    if (facing !== lastFacing.current) { lastFacing.current = facing; onFacing?.(facing); }
    const dist = camera.position.distanceTo(controls.current ? controls.current.target : ORIGIN);
    const pct = Math.round((fitDist / Math.max(0.001, dist)) * 100);
    if (pct !== lastPct.current) { lastPct.current = pct; onZoomPct?.(pct); }
  });

  // discrete zoom (dolly) + fit, driven by the on-screen zoom control (eased)
  useEffect(() => {
    if (!apiRef) return;
    // Add/subtract a fixed 10 percentage points of the fit size (100% = fit), so
    // 114% → 124% → 134% … The offset is additive (constant 10% step, no drift).
    // dir +1 = zoom in (higher %).
    const dollyStep = (dir: 1 | -1) => {
      const tgt = ctrlTarget();
      const offset = camera.position.clone().sub(tgt);
      const curPct = (fitDist / Math.max(0.001, offset.length())) * 100;
      const target = Math.max(1, curPct + dir * 10);
      const nl = Math.min(MAX_DIST, Math.max(MIN_DIST, (fitDist * 100) / target));
      animateTo(tgt.clone().add(offset.setLength(nl)), tgt); // zoom toward the current target
    };
    apiRef.current = {
      zoomIn: () => dollyStep(1),
      zoomOut: () => dollyStep(-1),
      // Fit: keep the currently-viewed page, square it up straight-on, recenter
      reset: () => animateTo(new THREE.Vector3(0, 0, camera.position.z >= 0 ? fitDist : -fitDist), ORIGIN.clone()),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return (
    <OrbitControls
      ref={controls}
      autoRotate={autoRotate}
      autoRotateSpeed={2.2}
      enablePan
      zoomToCursor
      enableDamping
      dampingFactor={0.22}   /* lighter inertia (drei default 0.05 feels too floaty) */
      minDistance={4}
      maxDistance={80}
    />
  );
}

export default function Preview3D({
  front, back, wMm, hMm, autoRotate, command, stageColor = '#454547',
  finish = 'matte', fold = 'none', foldAngle = 100, onFacing, controlRef,
}: Props) {
  const [pct, setPct] = useState(100);
  const internalApi = useRef<Zoom3DApi | null>(null);
  // the page drives zoom/fit through the same ref the on-screen buttons use
  const api = controlRef ?? internalApi;
  return (
    <div className="preview3dWrap">
      <Canvas
        camera={{ position: [0, 0, 14], fov: 40 }}
        style={{ width: '100%', height: '100%' }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
      >
        <color attach="background" args={[stageColor]} />
        <ambientLight intensity={1.15} />
        <directionalLight position={[6, 8, 10]} intensity={1.5} />
        <directionalLight position={[-5, -3, -9]} intensity={0.8} />
        {fold === 'none'
          ? <Paper front={front} back={back} wMm={wMm} hMm={hMm} finish={finish} />
          : <FoldedPaper front={front} back={back} wMm={wMm} hMm={hMm}
              panels={fold === 'half' ? 2 : 3} angleDeg={foldAngle}
              sameSide={fold === 'tri'} finish={finish} />}
        <Rig autoRotate={autoRotate} command={command} wMm={wMm} hMm={hMm}
          onFacing={onFacing} onZoomPct={setPct} apiRef={api} />
      </Canvas>
      <div className="zoomCtl" onPointerDown={(e) => e.stopPropagation()}>
        <button title="Zoom out" onClick={() => api.current?.zoomOut()}>−</button>
        <span className="zoomPct">{pct}%</span>
        <button title="Zoom in" onClick={() => api.current?.zoomIn()}>＋</button>
        <button title="Reset view" onClick={() => api.current?.reset()}>Fit</button>
      </div>
    </div>
  );
}
