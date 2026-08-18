'use client';

// 3D rotatable paper preview (graphic-style): the finished (trimmed) piece
// rendered onto a thin sheet you can drag-rotate / zoom, with front/back.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
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

function Rig({ autoRotate, command }: { autoRotate: boolean; command: ViewCommand }) {
  const { camera } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    const dist = Math.max(6, camera.position.length());
    if (command.cmd === 'front') camera.position.set(0, 0, dist);
    else if (command.cmd === 'back') camera.position.set(0, 0, -dist);
    else camera.position.set(3.2, 2.2, 12.5);
    camera.lookAt(0, 0, 0);
    controls.current?.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  return (
    <OrbitControls
      ref={controls}
      autoRotate={autoRotate}
      autoRotateSpeed={2.2}
      enablePan
      zoomToCursor
      minDistance={4}
      maxDistance={40}
    />
  );
}

export default function Preview3D({ front, back, wMm, hMm, autoRotate, command, stageColor = '#454547' }: Props) {
  return (
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
      <Rig autoRotate={autoRotate} command={command} />
    </Canvas>
  );
}
