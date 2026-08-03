#!/usr/bin/env python3
"""
ProdSched: Status Bar Transform
================================
แยก status bar ออกจาก planning block บน Gantt chart
- Block = แสดงแผน (product color เดิม) ไม่เปลี่ยนสีตาม running state
- Status bar = แถบบางๆ ใต้ block แสดง actual execution (เขียว=running, น้ำเงิน=done, แดง=alarm)

Usage:
  python3 status_bar_transform.py ProductionScheduler.jsx
  python3 status_bar_transform.py path/to/ProductionScheduler.jsx

Writes the result back to the same file (overwrites in-place).
"""
import sys, os, shutil

if len(sys.argv) < 2:
    print("Usage: python3 status_bar_transform.py <path-to-ProductionScheduler.jsx>")
    sys.exit(1)

filepath = sys.argv[1]
if not os.path.exists(filepath):
    print(f"Error: file not found: {filepath}")
    sys.exit(1)

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

original_len = len(content)
changes = []

def do_replace(old, new, label):
    global content
    if old not in content:
        print(f"  WARNING: could not find pattern for [{label}]")
        return
    content = content.replace(old, new, 1)
    changes.append(label)

# ────────────────────────────────────────────────────────────
# 1) Add Fragment to import
# ────────────────────────────────────────────────────────────
do_replace(
    'import { useState, useRef, useEffect, useMemo } from "react";',
    'import { useState, useRef, useEffect, useMemo, Fragment } from "react";',
    "add Fragment import"
)

# ────────────────────────────────────────────────────────────
# 2) Add status bar CSS animations
# ────────────────────────────────────────────────────────────
status_bar_css = """
        @keyframes ps-statusbar-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        .ps-statusbar-running {
          animation: ps-statusbar-pulse 1.8s ease-in-out infinite;
          box-shadow: 0 0 6px rgba(0,200,83,0.45);
        }
"""
do_replace(
    "        .ps-alarmraisebtn:hover",
    status_bar_css + "        .ps-alarmraisebtn:hover",
    "add status bar CSS"
)

# ────────────────────────────────────────────────────────────
# 3) Remove ps-job-running class from job block
# ────────────────────────────────────────────────────────────
do_replace(
    'className={`ps-job${job.isRunning && !blocked ? " ps-job-running" : ""}`}',
    'className="ps-job"',
    "remove ps-job-running class"
)

# ────────────────────────────────────────────────────────────
# 4) Change job block top/height to make room for status bar
# ────────────────────────────────────────────────────────────
do_replace(
    "                                                                        top: 7,\n                                                                        height: ROW_HEIGHT - 14,",
    "                                                                        top: 4,\n                                                                        height: ROW_HEIGHT - 18,",
    "adjust job block top/height"
)

# ────────────────────────────────────────────────────────────
# 5) Change background: remove running green from block
# ────────────────────────────────────────────────────────────
do_replace(
    'background: blocked ? "#FBE4E2" : job.isRunning ? JOB_RUNNING_GREEN : isDone ? "#E3F0FB" : isOverdue ? OVERDUE_AMBER_BG : job.locked ? `${color}22` : `${color}40`,',
    'background: blocked ? "#FBE4E2" : isDone ? "#E3F0FB" : isOverdue ? OVERDUE_AMBER_BG : job.locked ? `${color}22` : `${color}40`,',
    "remove running green from block background"
)

# ────────────────────────────────────────────────────────────
# 6) Change text color: running text no longer white
# ────────────────────────────────────────────────────────────
do_replace(
    'color: blocked ? ALARM_RED_DARK : job.isRunning ? "#FFFFFF" : "#262626",',
    'color: blocked ? ALARM_RED_DARK : "#262626",',
    "fix text color for running"
)

# ────────────────────────────────────────────────────────────
# 7) Remove running text shadow
# ────────────────────────────────────────────────────────────
do_replace(
    'textShadow: job.isRunning && !blocked ? "0 1px 2px rgba(0,60,20,0.35)" : "none",',
    'textShadow: "none",',
    "remove running text shadow"
)

# ────────────────────────────────────────────────────────────
# 8) Change RUNNING label: dark green text instead of white
# ────────────────────────────────────────────────────────────
do_replace(
    '                                                                        ) : job.isRunning ? (\n                                                                            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 800, color: "#FFFFFF", letterSpacing: "0.05em", whiteSpace: "nowrap", textShadow: "0 1px 2px rgba(0,60,20,0.35)" }}>\n                                                                                <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "#FFFFFF", flexShrink: 0 }} />\n                                                                                RUNNING\n                                                                            </div>',
    '                                                                        ) : job.isRunning ? (\n                                                                            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 800, color: RUNNING_GREEN_DARK, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>\n                                                                                <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: RUNNING_GREEN, flexShrink: 0 }} />\n                                                                                RUNNING\n                                                                            </div>',
    "RUNNING label colors"
)

# ────────────────────────────────────────────────────────────
# 9) Add status bar rendering after jobLinks
# ────────────────────────────────────────────────────────────
status_bar_jsx = '''
                                                    {/* ── Status bar: actual execution indicator beneath each job block ── */}
                                                    {scheduledJobs
                                                        .filter((j) => j.resourceId === r.id && (j.isRunning || j.completed))
                                                        .map((job) => {
                                                            const blocked = isJobBlocked(job);
                                                            const actualStartHour = job.runStartedAt
                                                                ? (new Date(job.runStartedAt).getTime() - baseDate.getTime()) / 3600000
                                                                : job.startHour;
                                                            let barWidthHours;
                                                            let barColor;
                                                            let isRunningBar = false;
                                                            if (blocked && job.isRunning) {
                                                                barWidthHours = Math.max(0.15, nowHour - actualStartHour);
                                                                barColor = ALARM_RED;
                                                            } else if (job.isRunning) {
                                                                barWidthHours = Math.max(0.15, nowHour - actualStartHour);
                                                                barColor = RUNNING_GREEN;
                                                                isRunningBar = true;
                                                            } else if (job.completed) {
                                                                barWidthHours = job.actualRunHours || job.duration;
                                                                barColor = DONE_BLUE;
                                                            } else {
                                                                return null;
                                                            }
                                                            const barLeft = actualStartHour * hourWidth;
                                                            const barW = Math.max(6, barWidthHours * hourWidth);
                                                            return (
                                                                <div
                                                                    key={`status-${job.id}`}
                                                                    className={isRunningBar ? "ps-statusbar-running" : undefined}
                                                                    title={
                                                                        job.isRunning
                                                                            ? `Running since ${new Date(job.runStartedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} (${barWidthHours.toFixed(1)}h elapsed)`
                                                                            : job.completed
                                                                            ? `Done \\u00b7 ${(job.actualRunHours || 0).toFixed(1)}h actual`
                                                                            : ""
                                                                    }
                                                                    style={{
                                                                        position: "absolute",
                                                                        left: barLeft,
                                                                        top: ROW_HEIGHT - 12,
                                                                        height: 5,
                                                                        width: barW,
                                                                        background: barColor,
                                                                        borderRadius: "0 2px 2px 0",
                                                                        borderLeft: `2px solid ${barColor}`,
                                                                        pointerEvents: "none",
                                                                        zIndex: 5,
                                                                        opacity: 0.85,
                                                                        transition: "width 0.4s ease",
                                                                    }}
                                                                />
                                                            );
                                                        })}
'''

# Find insertion point: right after the jobLinks rendering block ends,
# before the resource row's timeline </div> closes
insertion_marker = '''                                                        })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div
                                ref={poolRef}'''

replacement = '''                                                        })}
''' + status_bar_jsx + '''                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div
                                ref={poolRef}'''

do_replace(insertion_marker, replacement, "add status bar rendering")

# ────────────────────────────────────────────────────────────
# Write result
# ────────────────────────────────────────────────────────────
backup = filepath + '.bak'
shutil.copy2(filepath, backup)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\n✅ {len(changes)}/{9} transformations applied:")
for c in changes:
    print(f"   • {c}")
print(f"\n   Original: {original_len:,} chars")
print(f"   Modified: {len(content):,} chars")
print(f"   Backup:   {backup}")
print(f"\n   Output:   {filepath}")
