import { useEffect, useState } from "react";

/** Keep unresolved recovery work visible across view changes and reloads. */
export function StartupProblems({ root }: { root: string | undefined }) {
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    window.borges.library
      .startupProblems()
      .then((result) => {
        if (current) setProblems(result.ok ? result.value : [result.message]);
      })
      .catch((error: unknown) => {
        if (current)
          setProblems([
            `Startup diagnostics could not be read: ${String(error)}`,
          ]);
      });
    return () => {
      current = false;
    };
  }, []);
  if (problems.length === 0) return null;
  return (
    <section className="startup-problems" aria-label="Startup problems">
      <h2>Startup problems</h2>
      <p>
        Some recovery work needs inspection. Keep the files listed below while
        investigating; you can continue using the library.
      </p>
      <p>
        Library folder: <span>{root}</span>
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </section>
  );
}
