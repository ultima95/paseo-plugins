// Identification of the Supervisor, the daemon and the app main — the `$idt`
// block of the reference tool (`docs/gc-port/slp-gc.bash:323-341`).
//
// Every case is a hand-built process table plus a pid file value: no live
// process table, no `ps`/`lsof`, no daemon or agent interaction. The reference's
// `why` strings are asserted verbatim where they are quoted, because they are
// surfaced to the operator, and the refusal order is asserted by making two
// flags false at once and checking which one answered.
import { describe, expect, it } from "vitest";

import type { HomeState, IdentityInput, IdentityProc, ProcClassValue } from "./identity";
import { resolveIdentity } from "./identity";

/** One classified process, as `buildProcTable` hands it over. */
function proc(
  pid: number,
  ppid: number,
  cls: ProcClassValue | null,
  home: HomeState = "match",
): IdentityProc {
  return { pid, ppid, class: cls, home };
}

/** The healthy machine: app main 100, Supervisor 150 under it, daemon 200 under the Supervisor. */
const HEALTHY: IdentityProc[] = [
  proc(100, 1, "app-main", "unreadable"),
  proc(150, 100, "supervisor", "match"),
  proc(200, 150, "daemon", "match"),
];

const PID_FILE = { pid: 150, listen: "127.0.0.1:6767" };

function input(over: Partial<IdentityInput> = {}): IdentityInput {
  return {
    procs: HEALTHY,
    pidFile: PID_FILE,
    listen: [200],
    dupes: 0,
    homeDefault: false,
    ...over,
  };
}

describe("resolveIdentity — a healthy machine", () => {
  it("accepts the full chain and reports every flag", () => {
    const identity = resolveIdentity(input());
    expect(identity).toEqual({
      ok: true,
      why: "ok",
      pidFile: true,
      supervisor: true,
      daemon: true,
      listener: true,
      homeBound: true,
      inProcess: false,
      supHome: "match",
      listen: "127.0.0.1:6767",
      supervisorPid: 150,
      daemonPid: 200,
      appPid: 100,
    });
  });

  it("carries the pid file's listen value, or null when it has none", () => {
    expect(resolveIdentity(input({ pidFile: { pid: 150 } })).listen).toBeNull();
    expect(resolveIdentity(input({ pidFile: { pid: 150 } })).ok).toBe(true);
  });

  it("does not care about unrelated rows in the table", () => {
    const identity = resolveIdentity(
      input({
        procs: [...HEALTHY, proc(900, 1, "claude-child"), proc(901, 900, "agent-descendant"), proc(902, 1, null)],
      }),
    );
    expect(identity.ok).toBe(true);
  });

  it("accepts the daemon pid among several listeners", () => {
    expect(resolveIdentity(input({ listen: [42, 200, 43] })).listener).toBe(true);
  });
});

describe("resolveIdentity — the pid file (slp-gc.bash:323, 336)", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a missing read", undefined],
    ["an empty object", {}],
    ["a numeric string pid", { pid: "150" }],
    ["an array", [150]],
    // jq's `type == "object"` is false for an array; a value shaped like one is
    // not a pid file even if a `pid` key was somehow attached to it.
    ["an array carrying a pid", Object.assign([150], { pid: 150 })],
    ["a bare number", 150],
    ["an infinite pid", { pid: Number.POSITIVE_INFINITY }],
  ];

  it.each(cases)("refuses %s", (_name, pidFile) => {
    const identity = resolveIdentity(input({ pidFile }));
    expect(identity.ok).toBe(false);
    expect(identity.why).toBe("paseo.pid missing/unparseable");
    expect(identity.pidFile).toBe(false);
    expect(identity.supervisor).toBe(false);
    expect(identity.supervisorPid).toBeNull();
    expect(identity.appPid).toBeNull();
    expect(identity.daemon).toBe(false);
    expect(identity.daemonPid).toBeNull();
    // `$sup.home? // "unreadable"` — with no Supervisor there is no home to judge.
    expect(identity.supHome).toBe("unreadable");
  });
});

describe("resolveIdentity — the Supervisor (slp-gc.bash:324, 337)", () => {
  it("refuses a pid that is not a supervisor at all", () => {
    const identity = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "daemon", "match")],
        pidFile: { pid: 150 },
      }),
    );
    expect(identity.supervisor).toBe(false);
    expect(identity.why).toBe('pid in paseo.pid is not a live "Paseo Supervisor" child of an app main');
  });

  it("refuses a supervisor that is absent from the table", () => {
    const identity = resolveIdentity(input({ pidFile: { pid: 151 } }));
    expect(identity.supervisor).toBe(false);
    expect(identity.supervisorPid).toBeNull();
    expect(identity.daemon).toBe(false);
  });

  it("refuses a supervisor whose parent is not an app main", () => {
    // 99 is an ordinary process: the pid is a supervisor, but not the GUI's.
    const identity = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(99, 1, null), proc(150, 99, "supervisor")],
      }),
    );
    expect(identity.supervisor).toBe(false);
    expect(identity.supervisorPid).toBe(150);
    expect(identity.appPid).toBe(99);
    expect(identity.why).toContain('is not a live "Paseo Supervisor" child of an app main');
  });

  it("takes the first matching supervisor row, like the reference's `.[0]`", () => {
    const identity = resolveIdentity(
      input({
        procs: [
          proc(100, 1, "app-main", "unreadable"),
          proc(150, 100, "supervisor"),
          proc(160, 100, "supervisor"),
          proc(200, 150, "daemon"),
        ],
      }),
    );
    expect(identity.supervisorPid).toBe(150);
    expect(identity.ok).toBe(true);
  });

  it("ignores a supervisor row that is not the pid file's pid", () => {
    const identity = resolveIdentity(
      input({
        procs: [...HEALTHY, proc(160, 1, "supervisor")],
      }),
    );
    expect(identity.supervisorPid).toBe(150);
    expect(identity.ok).toBe(true);
  });
});

describe("resolveIdentity — the daemon (slp-gc.bash:326, 328-330, 338)", () => {
  it("refuses when there is no daemon child", () => {
    const identity = resolveIdentity(
      input({ procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor")] }),
    );
    expect(identity.daemon).toBe(false);
    expect(identity.daemonPid).toBeNull();
    expect(identity.listener).toBe(false);
    expect(identity.why).toBe('no single "Paseo Daemon" child of the Supervisor');
    // The Supervisor itself was still identified.
    expect(identity.supervisorPid).toBe(150);
    expect(identity.appPid).toBe(100);
  });

  it("refuses two daemons rather than picking one", () => {
    const identity = resolveIdentity(
      input({ procs: [...HEALTHY, proc(201, 150, "daemon")], listen: [200, 201] }),
    );
    expect(identity.daemon).toBe(false);
    expect(identity.daemonPid).toBeNull();
    expect(identity.listener).toBe(false);
    expect(identity.why).toBe('no single "Paseo Daemon" child of the Supervisor');
  });

  it("refuses a daemon that is not a child of the Supervisor", () => {
    const identity = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor"), proc(200, 999, "daemon")],
      }),
    );
    expect(identity.daemon).toBe(false);
    expect(identity.why).toBe('no single "Paseo Daemon" child of the Supervisor');
  });

  it("refuses when the daemon does not own the listener", () => {
    const identity = resolveIdentity(input({ listen: [201] }));
    expect(identity.daemon).toBe(true);
    expect(identity.daemonPid).toBe(200);
    expect(identity.listener).toBe(false);
    expect(identity.ok).toBe(false);
    expect(identity.why).toBe("the daemon does not own the listener from paseo.pid");
  });

  it("refuses an empty listener list", () => {
    const identity = resolveIdentity(input({ listen: [] }));
    expect(identity.listener).toBe(false);
    expect(identity.ok).toBe(false);
    expect(identity.why).toBe("the daemon does not own the listener from paseo.pid");
  });
});

describe("resolveIdentity — the home binding (slp-gc.bash:333, 340)", () => {
  const withSupervisorHome = (home: HomeState, homeDefault = false) =>
    resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor", home), proc(200, 150, "daemon")],
        homeDefault,
      }),
    );

  it("accepts a matching home", () => {
    const identity = withSupervisorHome("match");
    expect(identity.homeBound).toBe(true);
    expect(identity.supHome).toBe("match");
    expect(identity.ok).toBe(true);
  });

  it("accepts an unset PASEO_HOME only for the default home", () => {
    expect(withSupervisorHome("none", true).homeBound).toBe(true);
    expect(withSupervisorHome("none", true).ok).toBe(true);

    const notDefault = withSupervisorHome("none", false);
    expect(notDefault.homeBound).toBe(false);
    expect(notDefault.ok).toBe(false);
    expect(notDefault.supHome).toBe("none");
  });

  it("refuses a home that names another directory", () => {
    const identity = withSupervisorHome("other");
    expect(identity.homeBound).toBe(false);
    expect(identity.why).toContain('the Supervisor\'s PASEO_HOME is "other"');
    expect(identity.why).toContain("not proven to serve this home");
  });

  it("refuses an unreadable environment even for the default home", () => {
    for (const homeDefault of [true, false]) {
      const identity = withSupervisorHome("unreadable", homeDefault);
      expect(identity.homeBound).toBe(false);
      expect(identity.ok).toBe(false);
      expect(identity.supHome).toBe("unreadable");
      expect(identity.why).toContain('the Supervisor\'s PASEO_HOME is "unreadable"');
    }
  });
});

describe("resolveIdentity — the in-daemon proof (phase 3 parity break)", () => {
  const withSelf = (selfPid: number | undefined, home: HomeState = "unreadable", selfPpid?: number) =>
    resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor", home), proc(200, 150, "daemon")],
        listen: [200],
        ...(selfPid === undefined ? {} : { selfPid }),
        ...(selfPpid === undefined ? {} : { selfPpid }),
      }),
    );

  it("accepts when the identified daemon spawned this process", () => {
    const identity = withSelf(48609, "unreadable", 200);
    expect(identity.inProcess).toBe(true);
    expect(identity.ok).toBe(true);
  });

  it("still refuses when the daemon is neither this process nor its parent", () => {
    const identity = withSelf(48609, "unreadable", 999);
    expect(identity.inProcess).toBe(false);
    expect(identity.ok).toBe(false);
  });

  it("accepts an unreadable Supervisor home when this process is the identified daemon", () => {
    const identity = withSelf(200);
    expect(identity.homeBound).toBe(false);
    expect(identity.inProcess).toBe(true);
    expect(identity.ok).toBe(true);
    expect(identity.why).toBe("ok");
  });

  it("refuses when this process is not the identified daemon", () => {
    const identity = withSelf(999);
    expect(identity.inProcess).toBe(false);
    expect(identity.ok).toBe(false);
    expect(identity.why).toContain("this process is not the daemon the pid file names");
  });

  it("never treats an absent self pid as the daemon", () => {
    expect(withSelf(undefined).inProcess).toBe(false);
    expect(withSelf(undefined).ok).toBe(false);
  });

  it("still prefers the env proof when both hold", () => {
    const identity = withSelf(200, "match");
    expect(identity.homeBound).toBe(true);
    expect(identity.inProcess).toBe(true);
    expect(identity.ok).toBe(true);
  });

  it("does not let the in-daemon proof rescue a failed supervisor or listener", () => {
    const notListening = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor", "unreadable"), proc(200, 150, "daemon")],
        listen: [201],
        selfPid: 200,
      }),
    );
    expect(notListening.inProcess).toBe(true);
    expect(notListening.ok).toBe(false);
    expect(notListening.why).toBe("the daemon does not own the listener from paseo.pid");
  });
});

describe("resolveIdentity — refusal order and duplicates (slp-gc.bash:334-341)", () => {
  it("refuses a duplicate pid sample even when every flag holds", () => {
    // The fail-closed shape: the chain is perfect, but two rows for one pid mean
    // every pid-keyed lookup below it is unreliable.
    const identity = resolveIdentity(input({ dupes: 1 }));
    expect(identity.pidFile).toBe(true);
    expect(identity.supervisor).toBe(true);
    expect(identity.daemon).toBe(true);
    expect(identity.listener).toBe(true);
    expect(identity.homeBound).toBe(true);
    expect(identity.ok).toBe(false);
    expect(identity.why).toBe("duplicate pid rows in the ps output");
  });

  it("puts duplicate pid rows first", () => {
    // Everything else is also broken; the duplicate sample has to answer, because
    // every pid-keyed lookup below it is unreliable.
    const identity = resolveIdentity(
      input({ dupes: 2, pidFile: null, listen: [], procs: [] }),
    );
    expect(identity.ok).toBe(false);
    expect(identity.why).toBe("duplicate pid rows in the ps output");
  });

  it("puts the pid file before the supervisor", () => {
    const identity = resolveIdentity(input({ pidFile: null, procs: [], dupes: 0 }));
    expect(identity.why).toBe("paseo.pid missing/unparseable");
  });

  it("puts the supervisor before the daemon", () => {
    const identity = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 99, "supervisor")],
        listen: [],
      }),
    );
    expect(identity.why).toBe('pid in paseo.pid is not a live "Paseo Supervisor" child of an app main');
  });

  it("puts the daemon before the listener", () => {
    const identity = resolveIdentity(
      input({ procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor")], listen: [] }),
    );
    expect(identity.why).toBe('no single "Paseo Daemon" child of the Supervisor');
  });

  it("puts the listener before the home binding", () => {
    const identity = resolveIdentity(input({ listen: [], homeDefault: false }));
    expect(identity.why).toBe("the daemon does not own the listener from paseo.pid");
  });

  it("reports the home binding last", () => {
    const identity = resolveIdentity(
      input({
        procs: [proc(100, 1, "app-main", "unreadable"), proc(150, 100, "supervisor", "other"), proc(200, 150, "daemon")],
      }),
    );
    expect(identity.why).toContain("not proven to serve this home");
    expect(identity.ok).toBe(false);
  });

  it("is total: no input throws and every refusal carries a why", () => {
    const inputs: unknown[] = [
      {},
      { procs: [] },
      { procs: null, pidFile: null, listen: null, dupes: 0, homeDefault: false },
      { procs: [{ pid: 1 }], pidFile: { pid: 1 }, listen: [1], dupes: 0, homeDefault: false },
    ];
    for (const raw of inputs) {
      const identity = resolveIdentity(raw as IdentityInput);
      expect(typeof identity.ok).toBe("boolean");
      expect(typeof identity.why).toBe("string");
      expect(identity.why.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveIdentity — the duplicate count is one predicate for `ok` and `why` (slp-gc.bash:334-335)", () => {
  // Before this, `ok` tested `dupes === 0` while `why` tested `dupes > 0`, so a
  // count that was neither (`undefined`, `NaN`, a negative) produced the
  // contradictory answer `ok: false, why: "ok"`. Every other flag holds in these
  // cases, which is what makes the count the only possible reason.
  const withDupes = (dupes: unknown) => resolveIdentity(input({ dupes: dupes as number }));

  it("accepts exactly zero, and nothing else", () => {
    const zero = withDupes(0);
    expect(zero.ok).toBe(true);
    expect(zero.why).toBe("ok");

    for (const dupes of [1, 2, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
      const identity = withDupes(dupes);
      expect(identity.ok).toBe(false);
      expect(identity.why).toBe("duplicate pid rows in the ps output");
      // The whole chain was fine: the refusal is the count and names the count.
      expect(identity.pidFile).toBe(true);
      expect(identity.supervisor).toBe(true);
      expect(identity.daemon).toBe(true);
      expect(identity.listener).toBe(true);
      expect(identity.homeBound).toBe(true);
    }
  });

  it("never reports why: ok while ok is false, and never refuses while ok is true", () => {
    for (const dupes of [0, 1, 2, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const identity = withDupes(dupes);
      expect(identity.why === "ok").toBe(identity.ok);
    }
  });
});
