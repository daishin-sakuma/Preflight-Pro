'use client';

// 3D rotatable paper preview (graphic-style): the finished (trimmed) piece
// rendered onto a thin sheet you can drag-rotate / zoom, with front/back.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface ViewCommand { cmd: 'front' | 'back' | 'reset'; n: number }

interface Props {
  front: HTMLCanvasElement;
  back?: HTMLCanvasElement | null;
  wMm: number;
  hMm: number;
  autoRotate: boolean;
  command: ViewCommand;
  stageColor?: string;   // pasteboard colour (theme-dependent)
  onFacing?: (facing: 'front' | 'back') => void; // which face is toward the camera
}

function Paper({ front, back, wMm, hMm }: Pick<Props, 'front' | 'back' | 'wMm' | 'hMm'>) {
  const frontTex = useMemo(() => {
    const t = new THREE.CanvasTexture(front);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [front]);

  const backTex = useMemo(() => {
    if (!back) return null;
    const t = new THREE.CanvasTexture(back);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [back]);

  useEffect(() => () => { frontTex.dispose(); backTex?.dispose(); }, [frontTex, backTex]);

  // scale: fit long edge to ~10 scene units
  const long = Math.max(wMm, hMm);
  const w = (wMm / long) * 10;
  const h = (hMm / long) * 10;
  const t = 0.035;

  return (
    <mesh castShadow>
      <boxGeometry args={[w, h, t]} />
      {/* +x -x +y -y +z(front) -z(back) */}
      <meshStandardMaterial attach="material-0" color="#e8e8e6" />
      <meshStandardMaterial attach="material-1" color="#e8e8e6" />
      <meshStandardMaterial attach="material-2" color="#e8e8e6" />
      <meshStandardMaterial attach="material-3" color="#e8e8e6" />
      <meshStandardMaterial attach="material-4" map={frontTex} roughness={0.85} />
      {backTex
        ? <meshStandardMaterial attach="material-5" map={backTex} roughness={0.85} />
        : <meshStandardMaterial attach="material-5" color="#fbfbf9" roughness={0.9} />}
    </mesh>
  );
}

// viewing direction for the default (three-quarter) view
const VIEW_DIR = new THREE.Vector3(3.2, 2.2, 12.5).normalize();
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

  const place = (cmd: ViewCommand['cmd']) => {
    if (cmd === 'front') camera.position.set(0, 0, fitDist);
    else if (cmd === 'back') camera.position.set(0, 0, -fitDist);
    else camera.position.copy(VIEW_DIR).multiplyScalar(fitDist);
    camera.lookAt(0, 0, 0);
    controls.current?.update();
  };

  // explicit front/back/reset commands
  useEffect(() => { place(command.cmd); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // default framing: fit the whole piece on mount and whenever the sheet or
  // viewport changes size (so nothing is ever clipped by default)
  useEffect(() => { place('reset'); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitDist]);

  // report facing (page indicator) + zoom % (100% = fit distance); live during
  // drag / wheel / auto-rotate.
  useFrame(() => {
    const facing = camera.position.z >= 0 ? 'front' : 'back';
    if (facing !== lastFacing.current) { lastFacing.current = facing; onFacing?.(facing); }
    const pct = Math.round((fitDist / Math.max(0.001, camera.position.length())) * 100);
    if (pct !== lastPct.current) { lastPct.current = pct; onZoomPct?.(pct); }
  });

  // discrete zoom (dolly) + reset, driven by the on-screen zoom control
  useEffect(() => {
    if (!apiRef) return;
    const dolly = (factor: number) => {
      const len = camera.position.length();
      const nl = Math.min(MAX_DIST, Math.max(MIN_DIST, len * factor));
      camera.position.setLength(nl);
      camera.lookAt(0, 0, 0);
      controls.current?.update();
    };
    apiRef.current = {
      zoomIn: () => dolly(1 / 1.3),
      zoomOut: () => dolly(1.3),
      // Fit: keep the currently-viewed page, square it up straight-on, fit size
      reset: () => place(camera.position.z >= 0 ? 'front' : 'back'),
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
      minDistance={4}
      maxDistance={80}
    />
  );
}

export default function Preview3D({ front, back, wMm, hMm, autoRotate, command, stageColor = '#454547', onFacing }: Props) {
  const [pct, setPct] = useState(100);
  const api = useRef<Zoom3DApi | null>(null);
  return (
    <div className="preview3dWrap">
      <Canvas
        camera={{ position: [3.2, 2.2, 12.5], fov: 40 }}
        style={{ width: '100%', height: '100%' }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
      >
        <color attach="background" args={[stageColor]} />
        <ambientLight intensity={1.15} />
        <directionalLight position={[6, 8, 10]} intensity={1.5} />
        <directionalLight position={[-5, -3, -9]} intensity={0.8} />
        <Paper front={front} back={back} wMm={wMm} hMm={hMm} />
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
