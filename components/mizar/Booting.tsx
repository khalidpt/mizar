/** Full-screen placeholder while data or a view is loading. Server- and client-safe. */
export function Booting({ label = "initializing mizar array…" }: { label?: string }) {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-[#02040b] font-mono text-xs uppercase tracking-[0.4em] text-teal-300/70">
      <span className="animate-pulse">{label}</span>
    </div>
  );
}
