import type { ToolDefinition } from './registry.js';
import { bootBlameTool, bootInfoTool, bootTimeTool } from './boot.js';
import { cronListTool, cronRemoveTool, cronWriteTool } from './cron.js';
import { execAnyTool, execGapsTool, execTool, gapReportTool, scriptRunTool } from './exec.js';
import { fetchUrlTool, fwRuleTool, httpCheckTool, netDnsSetTool, netPingTool, netRouteTool, procReniceTool, usrActionTool } from './daily.js';
import { fsFindTool, fsGrepTool, fsLsTool, fsMountsTool, fsReadTool, fsSmartTool, fsUsageTool, fsWriteTool } from './fs.js';
import {
  fsArchiveListTool,
  fsArchiveTool,
  fsChecksumTool,
  fsChmodTool,
  fsChownTool,
  fsCopyTool,
  fsDuTool,
  fsMkdirTool,
  fsMoveTool,
  fsRemoveTool,
  fsSymlinkTool,
} from './fsops.js';
import { hwGpuTool, hwPciTool, hwPowerTool, hwSensorsTool, hwSummaryTool, hwUsbTool } from './hw.js';
import { jobKillTool, jobStartTool, jobStatusTool } from './job.js';
import { logBootsTool, logErrorsTool, logQueryTool, logUnitTailTool } from './log.js';
import { hostCapabilitiesTool, rawExecTool } from './meta.js';
import {
  netCheckTool,
  netConnsTool,
  netDnsTool,
  netFirewallTool,
  netPortsTool,
  netStatusTool,
  netWifiTool,
} from './net.js';
import {
  pkgInfoTool,
  pkgInstallTool,
  pkgOwnsTool,
  pkgRemoveTool,
  pkgSearchTool,
  pkgStatusTool,
  pkgUpdateTool,
} from './pkg.js';
import { netLinkTool } from './netlink.js';
import { dockerComposeTool, dockerInspectTool, dockerLogsTool, dockerPsTool } from './docker.js';
import { aurInstallTool, aurSearchTool, pkgCleanTool, pkgFilesTool, pkgSyncTool } from './pkg-extra.js';
import { kernelLogTool, modBlacklistTool, modInfoTool, modListTool, modLoadTool, modUnloadTool, sysctlGetTool, sysctlSetTool } from './kernel.js';
import { fsMountTool, fsUmountTool } from './mounts.js';
import { coredumpInfoTool, coredumpListTool, journalVacuumTool } from './diag.js';
import { usrListTool } from './users-extra.js';
import { usrPasswordTool } from './password.js';
import { svcTimerSetTool } from './timers.js';
import { netWifiActionTool } from './wifi.js';
import { secAuditTool, secSshConfigTool } from './sec.js';
import {
  svcActionTool,
  svcDaemonReloadTool,
  svcFailedTool,
  svcListTool,
  svcStatusTool,
  svcTimersTool,
  svcUnitFileTool,
} from './svc.js';
import {
  procKillTool,
  procListTool,
  sysInfoTool,
  sysMetricsTool,
  sysServicesSummaryTool,
  sysStatusTool,
} from './sys.js';
import { usrLoginsTool, usrSessionsTool } from './usr.js';
import { svcUnitDeleteTool, svcUnitWriteTool } from './units.js';

/** All tools, in catalog order. Profiles decide what gets registered. */
export const allTools: readonly ToolDefinition[] = [
  sysInfoTool,
  sysStatusTool,
  sysMetricsTool,
  procListTool,
  procKillTool,
  procReniceTool,
  sysServicesSummaryTool,
  svcListTool,
  svcStatusTool,
  svcFailedTool,
  svcActionTool,
  svcTimersTool,
  svcUnitFileTool,
  svcUnitWriteTool,
  svcUnitDeleteTool,
  svcTimerSetTool,
  svcDaemonReloadTool,
  modListTool,
  modInfoTool,
  modLoadTool,
  modUnloadTool,
  modBlacklistTool,
  sysctlGetTool,
  sysctlSetTool,
  kernelLogTool,
  cronListTool,
  cronWriteTool,
  cronRemoveTool,
  logQueryTool,
  logErrorsTool,
  logBootsTool,
  logUnitTailTool,
  coredumpListTool,
  coredumpInfoTool,
  journalVacuumTool,
  pkgStatusTool,
  pkgSearchTool,
  pkgInfoTool,
  pkgUpdateTool,
  pkgInstallTool,
  pkgRemoveTool,
  pkgOwnsTool,
  pkgFilesTool,
  pkgCleanTool,
  pkgSyncTool,
  aurSearchTool,
  aurInstallTool,
  netStatusTool,
  netPortsTool,
  netConnsTool,
  netCheckTool,
  netDnsTool,
  netWifiTool,
  netWifiActionTool,
  netFirewallTool,
  netPingTool,
  netDnsSetTool,
  netRouteTool,
  fwRuleTool,
  netLinkTool,
  dockerPsTool,
  dockerLogsTool,
  dockerInspectTool,
  dockerComposeTool,
  fsUsageTool,
  fsLsTool,
  fsFindTool,
  fsGrepTool,
  fsReadTool,
  fsWriteTool,
  fsSmartTool,
  fsMountsTool,
  fsMkdirTool,
  fsCopyTool,
  fsMoveTool,
  fsRemoveTool,
  fsChmodTool,
  fsChownTool,
  fsSymlinkTool,
  fsArchiveTool,
  fsArchiveListTool,
  fsChecksumTool,
  fsDuTool,
  fsMountTool,
  fsUmountTool,
  hwSummaryTool,
  hwSensorsTool,
  hwGpuTool,
  hwPciTool,
  hwUsbTool,
  hwPowerTool,
  bootInfoTool,
  bootTimeTool,
  bootBlameTool,
  usrSessionsTool,
  usrLoginsTool,
  usrActionTool,
  usrListTool,
  usrPasswordTool,
  secAuditTool,
  secSshConfigTool,
  jobStartTool,
  jobStatusTool,
  jobKillTool,
  hostCapabilitiesTool,
  httpCheckTool,
  fetchUrlTool,
  execGapsTool,
  execTool,
  execAnyTool,
  scriptRunTool,
  gapReportTool,
  rawExecTool,
];
