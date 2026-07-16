const api = require("./api");
const auth = require("./auth");

const ACCEPTED_STATE_TTL_MS = 15000;
const EXEMPT_ROUTES = {
  "pages/login/index": true,
  "pages/legal/index": true,
  "pages/agreement-consent/index": true,
};

let acceptedToken = "";
let acceptedUntil = 0;
let inflightCheck = null;

function normalizeRoute(route) {
  return String(route || "").replace(/^\/+/, "");
}

function pageRoute(page) {
  return normalizeRoute(page && (page.route || page.__route__));
}

function isExemptPage(page) {
  return !!EXEMPT_ROUTES[pageRoute(page)];
}

function isCurrentPage(page) {
  if (typeof getCurrentPages !== "function") return true;
  try {
    const pages = getCurrentPages();
    return !pages.length || pages[pages.length - 1] === page;
  } catch (error) {
    return true;
  }
}

function clearAcceptedState() {
  acceptedToken = "";
  acceptedUntil = 0;
}

function requiresAcceptance(session) {
  if (!session || session.loggedIn !== true) return false;
  return session.agreementsAccepted === false
    || !!(session.agreements && session.agreements.required === true);
}

function redirectToConsent(details) {
  clearAcceptedState();
  api.clearCache();
  auth.handleAgreementRequired({
    errCode: "AGREEMENT_ACCEPTANCE_REQUIRED",
    details: details || null,
  });
  return false;
}

function finishCheck(check, result) {
  if (inflightCheck && inflightCheck.promise === check) inflightCheck = null;
  return result;
}

function beforePageShow(page) {
  if (isExemptPage(page)) return true;

  const token = auth.getAccessToken();
  if (!token) {
    clearAcceptedState();
    return true;
  }
  if (acceptedToken === token && Date.now() < acceptedUntil) return true;
  if (inflightCheck && inflightCheck.token === token) return inflightCheck.promise;

  let check = null;
  check = Promise.resolve()
    .then(() => api.getSession({ force: true }))
    .then((session) => {
      if (requiresAcceptance(session)) {
        return redirectToConsent(session.agreements);
      }
      const currentToken = auth.getAccessToken();
      if (session && session.loggedIn === true && currentToken) {
        acceptedToken = currentToken;
        acceptedUntil = Date.now() + ACCEPTED_STATE_TTL_MS;
      } else {
        clearAcceptedState();
      }
      return true;
    })
    .catch((error) => {
      if (error && error.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED") {
        return redirectToConsent(error.details);
      }
      // Do not let stale business caches bypass a failed authoritative check.
      api.clearCache();
      clearAcceptedState();
      return true;
    })
    .then((result) => finishCheck(check, result));

  inflightCheck = { token, promise: check };
  return check;
}

module.exports = {
  beforePageShow,
  isCurrentPage,
  isExemptPage,
};
