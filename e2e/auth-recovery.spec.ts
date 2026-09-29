import { expect, test, type Page } from "@playwright/test";

const networkError = "요청을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도해주세요.";
const email = "auth-fixture@example.com";
const password = "synthetic-password-only";

function capturePageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("signup keeps entered details and allows retry after a lost connection", async ({ page }) => {
  const pageErrors = capturePageErrors(page);
  let attempts = 0;
  await page.route("**/api/auth/sign-up/email", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toMatchObject({ name: "Fixture Person", email, password, callbackURL: "/app" });
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ status: 403, json: { code: "REGISTRATION_CLOSED" } });
  });
  await page.goto("/dev/auth-e2e?form=sign-up");
  await page.getByLabel("이름", { exact: true }).fill("Fixture Person");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  const submit = page.getByRole("button", { name: "가입하고 시작하기", exact: true });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(networkError);
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("Fixture Person");
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue(email);
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue(password);
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("초대");
  await expect(submit).toBeEnabled();
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("signin distinguishes a lost connection from invalid credentials and retains its destination", async ({ page }) => {
  const pageErrors = capturePageErrors(page);
  let attempts = 0;
  await page.route("**/api/auth/sign-in/email", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      email,
      password,
      callbackURL: "/app?workspace=synthetic-workspace&document=synthetic-document",
    });
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ status: 401, json: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid credentials" } });
  });
  await page.goto("/dev/auth-e2e");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  const submit = page.getByRole("button", { name: "워크스페이스 열기", exact: true });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(networkError);
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue(email);
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue(password);
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("이메일과 비밀번호를 확인해주세요.");
  await expect(submit).toBeEnabled();
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("password recovery can resend after failure without losing the email address", async ({ page }) => {
  const pageErrors = capturePageErrors(page);
  let attempts = 0;
  await page.route("**/api/auth/request-password-reset", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ email, redirectTo: "/reset-password" });
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ status: 200, json: { status: true } });
  });
  await page.goto("/dev/auth-e2e?form=forgot");
  await page.getByLabel("가입한 이메일").fill(email);
  const submit = page.getByRole("button", { name: "재설정 메일 보내기" });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(networkError);
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel("가입한 이메일")).toHaveValue(email);
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("계정이 있다면 재설정 메일을 보냈어요. 받은편지함을 확인해주세요.");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("password reset preserves both passwords and completes a retry", async ({ page }) => {
  const pageErrors = capturePageErrors(page);
  let attempts = 0;
  await page.route("**/api/auth/reset-password", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ newPassword: password, token: "synthetic-reset-token" });
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ status: 200, json: { status: true } });
  });
  await page.goto("/dev/auth-e2e?form=reset");
  await page.getByLabel("새 비밀번호", { exact: true }).fill(password);
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(password);
  const submit = page.getByRole("button", { name: "새 비밀번호 저장" });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(networkError);
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel("새 비밀번호", { exact: true })).toHaveValue(password);
  await expect(page.getByLabel("새 비밀번호 확인", { exact: true })).toHaveValue(password);
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("새 비밀번호를 저장했어요.");
  await expect(page.getByRole("link", { name: "새 비밀번호로 로그인하기" })).toBeVisible();
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("email verification can resend after a lost connection", async ({ page }) => {
  const pageErrors = capturePageErrors(page);
  let attempts = 0;
  await page.route("**/api/auth/send-verification-email", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ email, callbackURL: "/app" });
    if (attempts === 1) await route.abort("failed");
    else await route.fulfill({ status: 200, json: { status: true } });
  });
  await page.goto("/dev/auth-e2e?form=verify");
  const submit = page.getByRole("button", { name: "인증 메일 다시 보내기" });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(networkError);
  await expect(submit).toBeEnabled();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("인증 메일을 다시 보냈어요. 받은편지함을 확인해주세요.");
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("retains disabled registration, unavailable mail and invalid reset boundaries", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/auth/")) requests.push(request.url());
  });
  await page.goto("/dev/auth-e2e?form=sign-up&blocked=1");
  await expect(page.getByRole("button", { name: "가입하고 시작하기", exact: true })).toBeDisabled();
  await page.goto("/dev/auth-e2e?form=forgot&noMail=1");
  await expect(page.getByLabel("가입한 이메일")).toBeDisabled();
  await expect(page.getByRole("button", { name: "재설정 메일 보내기" })).toBeDisabled();
  await page.goto("/dev/auth-e2e?form=reset&invalid=1");
  await expect(page.getByRole("button", { name: "새 비밀번호 저장" })).toBeDisabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("재설정 링크가 만료되었거나 유효하지 않습니다.");
  expect(requests).toEqual([]);
});

test("password mismatch remains local validation and the user can correct it", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/auth/reset-password", async (route) => {
    attempts += 1;
    await route.fulfill({ status: 200, json: { status: true } });
  });
  await page.goto("/dev/auth-e2e?form=reset");
  await page.getByLabel("새 비밀번호", { exact: true }).fill(password);
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(`${password}-different`);
  const submit = page.getByRole("button", { name: "새 비밀번호 저장" });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("두 비밀번호가 같지 않습니다.");
  expect(attempts).toBe(0);
  await expect(submit).toBeEnabled();
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(password);
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("새 비밀번호를 저장했어요.");
  expect(attempts).toBe(1);
});

for (const destination of [
  "/app?workspace=synthetic-workspace&document=synthetic-document",
  "/organization-invite?invite=synthetic-invitation",
  "/oauth/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=original-state",
]) {
  test(`email verification preserves the intended destination: ${destination}`, async ({ page }) => {
    const pageErrors = capturePageErrors(page);
    await page.route("**/api/auth/sign-in/email", async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ email, callbackURL: destination });
      await route.fulfill({ status: 403, json: { code: "EMAIL_NOT_VERIFIED", message: "Email is not verified" } });
    });
    let verificationSent = false;
    await page.route("**/api/auth/send-verification-email", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ email, callbackURL: destination });
      verificationSent = true;
      await route.fulfill({ status: 200, json: { status: true } });
    });

    await page.goto(`/sign-in?callbackURL=${encodeURIComponent(destination)}`);
    const signUp = page.getByRole("link", { name: "계정 만들기", exact: true });
    expect(new URL((await signUp.getAttribute("href"))!, page.url()).searchParams.get("callbackURL")).toBe(destination);
    await page.getByLabel("이메일", { exact: true }).fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "워크스페이스 열기", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/verify-email"
      && url.searchParams.get("email") === email
      && url.searchParams.get("callbackURL") === destination);
    await page.getByRole("button", { name: "인증 메일 다시 보내기" }).click();
    await expect(page.getByRole("status")).toHaveText("인증 메일을 다시 보냈어요. 받은편지함을 확인해주세요.");
    expect(verificationSent).toBe(true);
    const signIn = page.getByRole("link", { name: "로그인", exact: true });
    expect(new URL((await signIn.getAttribute("href"))!, page.url()).searchParams.get("callbackURL")).toBe(destination);
    expect(pageErrors).toEqual([]);
  });
}

test("signup carries an explicit destination into its verification request and screen", async ({ page }) => {
  const destination = "/app?workspace=synthetic-workspace&document=synthetic-document";
  await page.goto(`/sign-up?callbackURL=${encodeURIComponent(destination)}`);
  const signIn = page.getByRole("link", { name: "로그인", exact: true });
  expect(new URL((await signIn.getAttribute("href"))!, page.url()).searchParams.get("callbackURL")).toBe(destination);
  await page.route("**/api/auth/sign-up/email", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ email, callbackURL: destination });
    await route.fulfill({ status: 200, json: { user: { id: "synthetic-user" } } });
  });
  await page.goto(`/dev/auth-e2e?form=sign-up&callbackURL=${encodeURIComponent(destination)}`);
  await page.getByLabel("이름", { exact: true }).fill("Fixture Person");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/verify-email"
    && url.searchParams.get("callbackURL") === destination);
});

for (const unsafeDestination of ["https://outside.example/steal", "/\\outside.example/steal"]) {
  test(`rejects an external auth destination on sign-in and verification: ${unsafeDestination}`, async ({ page }) => {
    await page.route("**/api/auth/sign-in/email", async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ callbackURL: "/app" });
      await route.fulfill({ status: 403, json: { code: "EMAIL_NOT_VERIFIED", message: "Email is not verified" } });
    });
    await page.route("**/api/auth/send-verification-email", async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ callbackURL: "/app" });
      await route.fulfill({ status: 200, json: { status: true } });
    });
    await page.goto(`/sign-in?callbackURL=${encodeURIComponent(unsafeDestination)}`);
    await expect(page.getByRole("link", { name: "계정 만들기", exact: true })).toHaveAttribute("href", "/sign-up");
    await page.getByLabel("이메일", { exact: true }).fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "워크스페이스 열기", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/verify-email" && !url.searchParams.has("callbackURL"));
    await page.goto(`/verify-email?email=${encodeURIComponent(email)}&callbackURL=${encodeURIComponent(unsafeDestination)}`);
    await page.getByRole("button", { name: "인증 메일 다시 보내기" }).click();
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByRole("link", { name: "로그인", exact: true })).toHaveAttribute("href", "/sign-in");
    expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  });
}
