const { AppError } = require("../errors");
const { formatBeijingDateTime } = require("../time");
const { InCircleService } = require("../services/incircle");
const { AiService } = require("../services/ai");

async function readDatabaseHealth(fastify) {
  try {
    const db = await fastify.db.health();
    return {
      ok: true,
      databaseName: db.database_name,
      serverTime: formatBeijingDateTime(db.server_time),
    };
  } catch (error) {
    return {
      ok: false,
      errMsg: error.message,
    };
  }
}

async function handleHealth(fastify) {
  return {
    backend: "self-hosted",
    status: "ok",
    database: await readDatabaseHealth(fastify),
    serverTime: formatBeijingDateTime(),
  };
}

async function handleInitDatabase(fastify) {
  const database = await readDatabaseHealth(fastify);
  if (!database.ok) {
    throw new AppError("PostgreSQL is not ready", {
      statusCode: 503,
      errCode: "DATABASE_NOT_READY",
      details: database,
    });
  }
  return {
    initialized: true,
    note: "Run npm run db:migrate or docker compose exec api npm run db:migrate to apply schema.sql.",
    database,
  };
}

async function dispatchInCircleType(fastify, body, request) {
  const type = body && body.type;
  if (!type || typeof type !== "string") {
    throw new AppError("type is required", {
      statusCode: 400,
      errCode: "TYPE_REQUIRED",
    });
  }

  const service = new InCircleService(fastify, { request });
  const ai = () => new AiService(fastify, { request });
  switch (type) {
    case "incircleHealth":
      return handleHealth(fastify);
    case "incircleSession":
      return service.session(body);
    case "incircleLogin":
      throw new AppError("旧微信快捷登录已下线，请使用账号密码登录或注册绑定微信", {
        statusCode: 410,
        errCode: "LEGACY_LOGIN_DISABLED",
      });
    case "incircleAccountLogin":
      return service.accountLogin(body);
    case "incircleRegisterAccount":
      return service.registerAccount(body);
    case "incircleBindAccount":
      return service.bindAccount(body);
    case "incircleResetPassword":
      return service.resetPassword(body);
    case "incircleChangePassword":
      return service.changePassword(body);
    case "incircleUpdateTheme":
      return service.updateTheme(body);
    case "incircleLogout":
      return service.logout(body);
    case "incircleDeleteAccount":
      return service.deleteAccount(body);
    case "incircleListMyCircles":
      return service.listMyCircles(body);
    case "incircleCreateCircle":
      return service.createCircle(body);
    case "incircleSwitchCircle":
      return service.switchCircle(body);
    case "incircleJoinPreview":
      return service.joinPreview(body);
    case "incircleJoinCircle":
      return service.joinCircle(body);
    case "incircleCircleSettings":
      return service.circleSettings(body);
    case "incircleCircleMemberDetail":
      return service.circleMemberDetail(body);
    case "incircleUpdateCircleInfo":
      return service.updateCircleInfo(body);
    case "incircleExitCircle":
      return service.exitCircle(body);
    case "incircleDissolveCircle":
      return service.dissolveCircle(body);
    case "incircleRemoveCircleMember":
      return service.removeCircleMember(body);
    case "incircleGetInviteQrCode":
      return service.inviteQrCode(body);
    case "incircleAdminListCircles":
      return service.adminListCircles(body);
    case "incircleAdminOverview":
      return service.adminOverview(body);
    case "incircleAdminListUsers":
      return service.adminListUsers(body);
    case "incircleAdminUserDetail":
      return service.adminUserDetail(body);
    case "incircleAdminUpdateUserStatus":
      return service.adminUpdateUserStatus(body);
    case "incircleAdminUnbindUserWechat":
      return service.adminUnbindUserWechat(body);
    case "incircleAdminDeleteUser":
      return service.adminDeleteUser(body);
    case "incircleAdminUpdateCircleStatus":
      return service.adminUpdateCircleStatus(body);
    case "incircleAdminDeleteCircle":
      return service.adminDeleteCircle(body);
    case "incircleAdminOperationLogs":
      return service.adminOperationLogs(body);
    case "incircleAdminDeleteOperationLogs":
      return service.adminDeleteOperationLogs(body);
    case "incircleHome":
      return service.home(body);
    case "incircleActivities":
      return service.activities(body);
    case "incircleActivityDetail":
      return service.activityDetail(body);
    case "incircleCreateActivity":
      return service.createActivity(body);
    case "incircleUpdateActivity":
      return service.updateActivity(body);
    case "incircleDeleteActivity":
      return service.deleteActivity(body);
    case "incircleUpdateActivityStatus":
      return service.updateActivityStatus(body);
    case "incircleFinishActivity":
      return service.finishActivity(body);
    case "incircleAddActivityPhoto":
      return service.addActivityPhoto(body);
    case "incircleTools":
      return service.tools(body);
    case "incircleBillDetail":
      return service.billDetail(body);
    case "incircleCreateBill":
      return service.createBill(body);
    case "incircleUpdateBill":
      return service.updateBill(body);
    case "incircleDeleteBill":
      return service.deleteBill(body);
    case "incircleCreateBillFromActivity":
      return service.createBillFromActivity(body);
    case "incircleSettleBill":
      return service.settleBill(body);
    case "incircleRemindBill":
      return service.remindBill(body);
    case "incircleVoteDetail":
      return service.voteDetail(body);
    case "incircleCreateVote":
      return service.createVote(body);
    case "incircleUpdateVote":
      return service.updateVote(body);
    case "incircleDeleteVote":
      return service.deleteVote(body);
    case "incircleVoteOption":
      return service.voteOption(body);
    case "incircleVetoVoteOption":
      return service.vetoVoteOption(body);
    case "incircleFinishVote":
      return service.finishVote(body);
    case "incircleCheckinDetail":
      return service.checkinDetail(body);
    case "incircleCreateCheckin":
      return service.createCheckin(body);
    case "incircleUpdateCheckin":
      return service.updateCheckin(body);
    case "incircleDeleteCheckin":
      return service.deleteCheckin(body);
    case "incircleUseCheckinCard":
      return service.useCheckinCard(body);
    case "incircleCheckIn":
      return service.checkIn(body);
    case "incircleUpdateCheckinRecordMedia":
      return service.updateCheckinRecordMedia(body);
    case "incircleRunCheckinPunishment":
      return service.runCheckinPunishment(body);
    case "incircleRunDecision":
      return service.runDecision(body);
    case "incircleDocs":
      return service.docs(body);
    case "incircleDocDetail":
      return service.docDetail(body);
    case "incircleCreateDoc":
      return service.createDoc(body);
    case "incircleUpdateDoc":
      return service.updateDoc(body);
    case "incircleDeleteDoc":
      return service.deleteDoc(body);
    case "incircleMembers":
      return service.members(body);
    case "incircleScoreLogs":
      return service.scoreLogs(body);
    case "incircleMemberDetail":
      return service.memberDetail(body);
    case "incircleUpdateMyCard":
      return service.updateMyCard(body);
    case "incircleAddMemberTag":
      return service.addMemberTag(body);
    case "incircleProposeMemberTag":
      return service.proposeMemberTag(body);
    case "incircleVoteMemberTagProposal":
      return service.voteMemberTagProposal(body);
    case "incircleRemoveMemberTag":
      return service.removeMemberTag(body);
    case "incircleAppealMemberTag":
      return service.appealMemberTag(body);
    case "incircleAiStatus":
      return ai().status(body);
    case "incircleAiSettings":
      return ai().settings(body);
    case "incircleAiUpdateSettings":
      return ai().updateSettings(body);
    case "incircleAiListProviders":
      return ai().listProviders(body);
    case "incircleAiSaveProvider":
      return ai().saveProvider(body);
    case "incircleAiArchiveProvider":
      return ai().archiveProvider(body);
    case "incircleAiTestProvider":
      return ai().testProvider(body);
    case "incircleAiListModels":
      return ai().listModels(body);
    case "incircleAiSyncModels":
      return ai().syncModels(body);
    case "incircleAiSaveModel":
      return ai().saveModel(body);
    case "incircleAiUpdateModel":
      return ai().updateModel(body);
    case "incircleAiTestModel":
      return ai().testModel(body);
    case "incircleAiListConversations":
      return ai().listConversations(body);
    case "incircleAiCreateConversation":
      return ai().createConversation(body);
    case "incircleAiDeleteConversation":
      return ai().deleteConversation(body);
    case "incircleAiListMessages":
      return ai().listMessages(body);
    case "incircleAiCancelGeneration":
      return ai().cancelGeneration(body);
    case "incircleAiGrantConsent":
      return ai().grantConsent(body);
    case "incircleAiReportMessage":
      return ai().reportMessage(body);
    case "incircleAiUsage":
      return ai().usage(body);
    case "incircleAiReports":
      return ai().listReports(body);
    case "incircleAiUpdateReport":
      return ai().updateReport(body);
    case "incircleInitDatabase":
      return handleInitDatabase(fastify);
    default:
      throw new AppError(`HTTP backend has not ported ${type} yet`, {
        statusCode: 501,
        errCode: "TYPE_NOT_PORTED",
        details: {
          type,
          nextStep: "Add this type to the self-hosted HTTP service dispatch table.",
        },
      });
  }
}

async function incircleRoutes(fastify) {
  fastify.post("/incircle", async (request, reply) => {
    const startedAt = Date.now();
    const type = String((request.body && request.body.type) || "unknown").slice(0, 80);
    try {
      const data = await dispatchInCircleType(fastify, request.body || {}, request);
      reply.send({
        success: true,
        data,
      });
    } finally {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 2000 && request.log && typeof request.log.warn === "function") {
        request.log.warn({ apiAction: type, durationMs }, "Slow InCircle API action");
      }
    }
  });
}

module.exports = {
  incircleRoutes,
};
