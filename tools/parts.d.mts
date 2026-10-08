// Types for tools/parts.mjs (the build script uses it as plain JavaScript; the tests import it from TypeScript).

export interface Piece {
  root: number;
  tris: number;
  center: [number, number, number];
  sizeMm: [number, number, number];
  volCm3: number;
  added: boolean;
}

export const SERVO: { tris: number; volCm3: number; lengthMm: number };
export function splitPieces(position: ArrayLike<number>, index: ArrayLike<number>, addedFrom?: number): { pieces: Piece[]; vertexPiece: Int32Array };
export function isServoPiece(p: Piece): boolean;
export function nameParts(body: { name: string; joint: { name: string; axis: [number, number, number] } | null }, pieces: Piece[]): { parts: (Piece & { name: string; kind: string; basis: string })[]; partOfPiece: Int32Array };
export function summary(pieces: Piece[]): { pieces: number; slivers: number; parts: number; servos: number };
