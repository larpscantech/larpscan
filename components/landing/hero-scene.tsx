'use client';

import { useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Float,
  MeshTransmissionMaterial,
  PerspectiveCamera,
  Sparkles,
} from '@react-three/drei';
import type { Group, Mesh } from 'three';
import { Color, MathUtils } from 'three';

function PointerRig() {
  const groupRef = useRef<Group>(null);
  const { pointer } = useThree();

  useFrame((_, delta) => {
    if (!groupRef.current) {
      return;
    }

    groupRef.current.rotation.y = MathUtils.damp(
      groupRef.current.rotation.y,
      pointer.x * 0.35,
      4,
      delta,
    );
    groupRef.current.rotation.x = MathUtils.damp(
      groupRef.current.rotation.x,
      pointer.y * 0.18,
      4,
      delta,
    );
    groupRef.current.position.x = MathUtils.damp(
      groupRef.current.position.x,
      pointer.x * 0.35,
      4,
      delta,
    );
    groupRef.current.position.y = MathUtils.damp(
      groupRef.current.position.y,
      pointer.y * 0.18,
      4,
      delta,
    );
  });

  return (
    <group ref={groupRef}>
      <Float speed={1.8} rotationIntensity={0.5} floatIntensity={1}>
        <CoreMesh />
      </Float>
      <OrbitShell />
      <SignalDroplets />
    </group>
  );
}

function CoreMesh() {
  const meshRef = useRef<Mesh>(null);

  useFrame((state, delta) => {
    if (!meshRef.current) {
      return;
    }

    meshRef.current.rotation.x += delta * 0.18;
    meshRef.current.rotation.y += delta * 0.26;
    meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.9) * 0.08;
  });

  return (
    <mesh ref={meshRef} scale={1.28}>
      <icosahedronGeometry args={[1.05, 18]} />
      <MeshTransmissionMaterial
        backside
        samples={6}
        resolution={256}
        thickness={0.7}
        roughness={0.08}
        ior={1.15}
        chromaticAberration={0.12}
        distortion={0.24}
        distortionScale={0.45}
        temporalDistortion={0.22}
        anisotropy={0.3}
        color="#ffd7f6"
      />
    </mesh>
  );
}

function OrbitShell() {
  const groupRef = useRef<Group>(null);

  useFrame((state) => {
    if (!groupRef.current) {
      return;
    }

    groupRef.current.rotation.z = state.clock.elapsedTime * 0.12;
    groupRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.4) * 0.2;
  });

  return (
    <group ref={groupRef}>
      <mesh rotation={[Math.PI / 2.8, 0, 0]} scale={1.9}>
        <torusGeometry args={[1.2, 0.018, 32, 180]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.38} />
      </mesh>
      <mesh rotation={[Math.PI / 1.6, Math.PI / 8, 0]} scale={1.55}>
        <torusGeometry args={[1.4, 0.012, 32, 180]} />
        <meshBasicMaterial color="#adbbff" transparent opacity={0.32} />
      </mesh>
      <mesh rotation={[0.4, 0.8, 0]} scale={[2.8, 1.4, 1.4]}>
        <torusGeometry args={[1, 0.01, 24, 160]} />
        <meshBasicMaterial color="#ff92da" transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

function SignalDroplets() {
  const groupRef = useRef<Group>(null);
  const colors = useMemo(
    () => ['#ffffff', '#ffd6f4', '#aab7ff'].map((value) => new Color(value)),
    [],
  );

  useFrame((state) => {
    if (!groupRef.current) {
      return;
    }

    groupRef.current.rotation.y = -state.clock.elapsedTime * 0.18;
    groupRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.45) * 0.08;
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: 10 }, (_, index) => {
        const angle = (index / 10) * Math.PI * 2;
        const radius = 1.9 + (index % 3) * 0.16;
        const color = colors[index % colors.length];

        return (
          <mesh
            key={index}
            position={[
              Math.cos(angle) * radius,
              Math.sin(angle * 1.4) * 0.4,
              Math.sin(angle) * radius * 0.65,
            ]}
            scale={0.06 + (index % 4) * 0.02}
          >
            <sphereGeometry args={[1, 24, 24]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.5} />
          </mesh>
        );
      })}
    </group>
  );
}

export function HeroScene() {
  return (
    <Canvas dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }}>
      <color attach="background" args={['#000000']} />
      <fog attach="fog" args={['#05010a', 5.5, 12]} />
      <PerspectiveCamera makeDefault position={[0, 0, 5.8]} fov={34} />
      <ambientLight intensity={0.7} color="#ffffff" />
      <directionalLight position={[3, 3, 4]} intensity={2.4} color="#ffe2fb" />
      <pointLight position={[-3, -2, 3]} intensity={20} color="#7f7dff" distance={10} />
      <pointLight position={[2.2, 1.6, 2]} intensity={10} color="#ff7bbf" distance={8} />
      <Sparkles
        count={55}
        size={3.2}
        scale={[7, 5, 5]}
        speed={0.35}
        noise={1.4}
        color="#ffffff"
      />
      <PointerRig />
    </Canvas>
  );
}
