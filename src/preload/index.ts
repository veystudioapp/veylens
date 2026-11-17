import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"

import {
  IPC,
  type ChatEvent,
  type DesktopApi,
  type GatewayState,
  type UpdateProgress,
} from "../shared/api"

const api: DesktopApi = {
  platform: process.platform as DesktopApi["platform"],

  listConnections: () => ipcRenderer.invoke(IPC.listConnections),
  saveConnection: (id, input) =>
    ipcRenderer.invoke(IPC.saveConnection, id, input),
  deleteConnection: (id) => ipcRenderer.invoke(IPC.deleteConnection, id),
  testConnection: (id, input) =>
    ipcRenderer.invoke(IPC.testConnection, id, input),
  pickDataFiles: () => ipcRenderer.invoke(IPC.pickDataFiles),
  googleAccount: () => ipcRenderer.invoke(IPC.googleAccount),
  importGoogleClient: () => ipcRenderer.invoke(IPC.importGoogleClient),
  forgetGoogleClient: () => ipcRenderer.invoke(IPC.forgetGoogleClient),
  signInWithGoogle: () => ipcRenderer.invoke(IPC.signInWithGoogle),
  cancelGoogleSignIn: () => ipcRenderer.invoke(IPC.cancelGoogleSignIn),
  signOutOfGoogle: () => ipcRenderer.invoke(IPC.signOutOfGoogle),

  getTree: (connectionId) => ipcRenderer.invoke(IPC.getTree, connectionId),
  listObjects: (connectionId) => ipcRenderer.invoke(IPC.listObjects, connectionId),
  setPermissions: (connectionId, permissions) =>
    ipcRenderer.invoke(IPC.setPermissions, connectionId, permissions),
  getTable: (connectionId, ref) =>
    ipcRenderer.invoke(IPC.getTable, connectionId, ref),
  getTableDetails: (connectionId, ref) =>
    ipcRenderer.invoke(IPC.getTableDetails, connectionId, ref),
  getRows: (connectionId, request) =>
    ipcRenderer.invoke(IPC.getRows, connectionId, request),
  applyChanges: (connectionId, changes) =>
    ipcRenderer.invoke(IPC.applyChanges, connectionId, changes),
  runQuery: (connectionId, sql, readOnly, params) =>
    ipcRenderer.invoke(IPC.runQuery, connectionId, sql, readOnly, params),
  explainQuery: (connectionId, sql) =>
    ipcRenderer.invoke(IPC.explainQuery, connectionId, sql),
  getSchemaDiagram: (connectionId, schema) =>
    ipcRenderer.invoke(IPC.getSchemaDiagram, connectionId, schema),

  listAlerts: () => ipcRenderer.invoke(IPC.listAlerts),
  saveAlert: (input) => ipcRenderer.invoke(IPC.saveAlert, input),
  deleteAlert: (alertId) => ipcRenderer.invoke(IPC.deleteAlert, alertId),
  checkAlert: (alertId) => ipcRenderer.invoke(IPC.checkAlert, alertId),

  getKnowledge: (connectionId) =>
    ipcRenderer.invoke(IPC.getKnowledge, connectionId),
  saveKnowledge: (connectionId, knowledge) =>
    ipcRenderer.invoke(IPC.saveKnowledge, connectionId, knowledge),
  listDashboards: () => ipcRenderer.invoke(IPC.listDashboards),
  saveDashboard: (dashboard) => ipcRenderer.invoke(IPC.saveDashboard, dashboard),
  deleteDashboard: (dashboardId) =>
    ipcRenderer.invoke(IPC.deleteDashboard, dashboardId),
  listAudit: () => ipcRenderer.invoke(IPC.listAudit),
  clearAudit: () => ipcRenderer.invoke(IPC.clearAudit),
  pinToDashboard: (input) => ipcRenderer.invoke(IPC.pinToDashboard, input),
  exportDashboard: (input) => ipcRenderer.invoke(IPC.exportDashboard, input),

  listSkills: () => ipcRenderer.invoke(IPC.listSkills),
  saveSkill: (input) => ipcRenderer.invoke(IPC.saveSkill, input),
  deleteSkill: (skillId) => ipcRenderer.invoke(IPC.deleteSkill, skillId),
  resetSkill: (skillId) => ipcRenderer.invoke(IPC.resetSkill, skillId),
  getTableFields: (connectionId, ref) =>
    ipcRenderer.invoke(IPC.getTableFields, connectionId, ref),
  setFieldSettings: (connectionId, ref, column, settings) =>
    ipcRenderer.invoke(IPC.setFieldSettings, connectionId, ref, column, settings),
  setDisplayColumn: (connectionId, ref, column) =>
    ipcRenderer.invoke(IPC.setDisplayColumn, connectionId, ref, column),
  getToolModes: () => ipcRenderer.invoke(IPC.getToolModes),
  setToolMode: (tool, mode) => ipcRenderer.invoke(IPC.setToolMode, tool, mode),
  getAiSettings: () => ipcRenderer.invoke(IPC.getAiSettings),
  setAiSettings: (settings) => ipcRenderer.invoke(IPC.setAiSettings, settings),

  assistSql: (input) => ipcRenderer.invoke(IPC.assistSql, input),
  cancelAssist: (requestId) => ipcRenderer.invoke(IPC.cancelAssist, requestId),
  summarizeDashboard: (input) => ipcRenderer.invoke(IPC.summarizeDashboard, input),

  agentStatus: () => ipcRenderer.invoke(IPC.agentStatus),
  agentModels: (fresh) => ipcRenderer.invoke(IPC.agentModels, fresh),
  listChats: () => ipcRenderer.invoke(IPC.listChats),
  createChat: () => ipcRenderer.invoke(IPC.createChat),
  getChat: (chatId) => ipcRenderer.invoke(IPC.getChat, chatId),
  deleteChat: (chatId) => ipcRenderer.invoke(IPC.deleteChat, chatId),
  sendMessage: (input) => ipcRenderer.invoke(IPC.sendMessage, input),
  chatImage: (name) => ipcRenderer.invoke(IPC.chatImage, name),
  stopChat: (chatId) => ipcRenderer.invoke(IPC.stopChat, chatId),
  answerApproval: (chatId, toolId, allow) =>
    ipcRenderer.invoke(IPC.answerApproval, chatId, toolId, allow),

  onChatEvent: (listener) => {
    // Only the payload goes through: the event carries a `sender` the page
    // has no business holding.
    const handler = (_event: IpcRendererEvent, payload: ChatEvent) =>
      listener(payload)
    ipcRenderer.on(IPC.chatEvent, handler)
    return () => {
      ipcRenderer.off(IPC.chatEvent, handler)
    }
  },

  getGateway: () => ipcRenderer.invoke(IPC.getGateway),
  saveGateway: (settings) => ipcRenderer.invoke(IPC.saveGateway, settings),
  deleteGateway: (gatewayId) => ipcRenderer.invoke(IPC.deleteGateway, gatewayId),
  switchGateway: (gatewayId, connectionId) =>
    ipcRenderer.invoke(IPC.switchGateway, gatewayId, connectionId),
  resetGatewayPassword: (gatewayId) => ipcRenderer.invoke(IPC.resetGatewayPassword, gatewayId),
  onGatewayState: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: GatewayState) =>
      listener(payload)
    ipcRenderer.on(IPC.gatewayState, handler)
    return () => {
      ipcRenderer.off(IPC.gatewayState, handler)
    }
  },

  appVersion: () => ipcRenderer.invoke(IPC.appVersion),
  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
  installUpdate: (version) => ipcRenderer.invoke(IPC.installUpdate, version),
  onUpdateProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: UpdateProgress) =>
      listener(payload)
    ipcRenderer.on(IPC.updateProgress, handler)
    return () => {
      ipcRenderer.off(IPC.updateProgress, handler)
    }
  },
}

contextBridge.exposeInMainWorld("veylens", api)
