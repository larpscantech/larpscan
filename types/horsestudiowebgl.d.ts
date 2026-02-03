declare module 'horsestudiowebgl' {
  interface ShaderPreset {
    id: string;
    name: string;
    mode: string;
    fragmentShader: string;
    mouseLerp: number;
    noiseOverlay: unknown;
    vignetteOverlay: unknown;
    defaultControls: Record<string, unknown>;
    components: string[];
    families: string[];
    summary: string;
  }

  export function createShaderPreset(shaderId: string): ShaderPreset;
  export function createDefaultControls(shaderId: string): Record<string, unknown>;
  export function getShaderPreset(shaderId: string): ShaderPreset | null;
  export function listShaderPresets(): { id: string; name: string; mode: string }[];
  export const shaderStudioVersion: string;
}
