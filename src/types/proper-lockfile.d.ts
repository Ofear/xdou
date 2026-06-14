declare module 'proper-lockfile' {
  interface LockOptions {
    stale?: number;
    realpath?: boolean;
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number };
    onCompromised?: (error: Error) => void;
  }
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;
}
