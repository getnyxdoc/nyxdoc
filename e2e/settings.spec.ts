import { expect, test } from "@playwright/test";

test("keeps site-wide administration separate from workspace settings and never submits secrets", async ({ page }) => {
  let updateBody: Record<string, unknown> | null = null;
  await page.route("**/api/settings/site", async (route) => {
    updateBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        site: {
          administratorRole: "owner",
           settings: {
             publicBaseUrl: "https://docs.example.com",
             registrationMode: "invite",
             emailVerificationEnabled: true,
            emailDomainPolicy: "any",
            allowedEmailDomains: [],
            smtp: {
              host: "smtp.example.com",
              port: 587,
              secure: false,
              user: "no-reply@example.com",
              from: "Nyxdoc <no-reply@example.com>",
              passwordConfigured: true,
            },
            version: 2,
            persisted: true,
            restartRequired: true,
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
          runtime: {
            sourceRevision: "settings-e2e",
            environment: "development",
            httpsEnabled: true,
            certificateManagement: "reverse-proxy",
            databaseConfigured: true,
            mediaStorageConfigured: true,
            backupStorageConfigured: true,
            collaborationPublicUrl: "wss://docs.example.com/collaboration",
          },
           counts: {
             users: 1,
            activeWorkspaces: 2,
            activeAgents: 2,
             activeDocuments: 18,
           },
           invites: [],
           users: [{
             id: "site-owner-e2e",
             name: "James",
             email: "james@example.com",
             image: null,
             locale: "ko",
             siteRole: "owner",
             createdAt: "2026-07-20T00:00:00.000Z",
           }],
           auditEvents: [{
            cursor: 1,
            id: "site-audit-e2e",
            action: "site.settings.updated",
            actorLabel: "James",
            metadata: {},
            createdAt: "2026-07-20T00:00:00.000Z",
          }],
        },
      }),
    });
  });

  await page.goto("/dev/settings-e2e?area=site");

  await expect(page.getByRole("heading", { name: "사이트 관리", exact: true })).toBeVisible();
  await expect(page.getByText("사이트 전체", { exact: true })).toBeVisible();
  await expect(page.getByText("사이트 소유자", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("작업 중인 워크스페이스")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "공개 주소와 HTTPS" })).toBeVisible();
  await expect(page.getByText("리버스 프록시에서 관리")).toBeVisible();
  await expect(page.getByText(/SMTP 비밀번호 · 환경 변수에 설정됨/)).toBeVisible();

  await page.getByLabel("사이트 공개 주소").fill("https://docs.example.com");
  await page.getByLabel("가입 가능 범위").selectOption("any");
  await page.getByRole("button", { name: "사이트 설정 저장" }).click();

  await expect.poll(() => updateBody).toMatchObject({
    expectedVersion: 1,
    publicBaseUrl: "https://docs.example.com",
    emailVerificationEnabled: true,
    emailDomainPolicy: "any",
    allowedEmailDomains: [],
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "no-reply@example.com",
      from: "Nyxdoc <no-reply@example.com>",
    },
  });
  expect(JSON.stringify(updateBody)).not.toContain("password");
  await expect(page.getByText("사이트 설정을 저장했습니다.")).toBeVisible();
  await expect(page.getByText(/앱을 재시작해주세요/)).toBeVisible();
});

test("separates global agent identity from workspace assignments", async ({ page }) => {
  await page.goto("/dev/settings-e2e?area=account");

  await expect(page.getByRole("heading", { name: "계정 설정", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트와 연결 키", exact: true })).toHaveCount(0);

  await page.goto("/dev/settings-e2e?area=agents");

  await expect(page.getByRole("heading", { name: "에이전트", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트 신원", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "연결 키", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트 배정과 권한", exact: true })).toHaveCount(0);

  await page.goto("/dev/settings-e2e");

  await expect(page.getByRole("heading", { name: "워크스페이스 설정", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트 배정과 권한", exact: true })).toBeVisible();
  await expect(page.getByText("신원과 키는 계정에 한 번만 등록됩니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "에이전트 연결", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트와 연결 키", exact: true })).toHaveCount(0);
});

test("returns from every settings area to the exact document that opened it", async ({ page }) => {
  const documentId = "00000000-0000-4000-8000-000000000006";
  await page.goto(`/dev/settings-e2e?area=account&document=${documentId}`);

  const expectedReturn = `/app?workspace=settings-workspace-e2e&document=${documentId}`;
  await expect(page.getByRole("link", { name: "nyxdoc" })).toHaveAttribute(
    "href",
    expectedReturn,
  );
  await expect(page.getByRole("link", { name: "문서로 돌아가기" })).toHaveAttribute(
    "href",
    expectedReturn,
  );
  await expect(page.getByRole("link", { name: "에이전트 관리" })).toHaveAttribute(
    "href",
    `/settings/agents?workspace=settings-workspace-e2e&document=${documentId}`,
  );
  await expect(page.getByRole("link", { name: "워크스페이스 설정" })).toHaveAttribute(
    "href",
    `/settings/workspace?workspace=settings-workspace-e2e&document=${documentId}`,
  );
});

test("starts workspace creation from the global workspace selector", async ({ page }) => {
  await page.goto("/dev/settings-e2e");

  await expect(page.getByRole("heading", { name: "워크스페이스 삭제" })).toBeVisible();
  const selector = page.getByLabel("작업 중인 워크스페이스");
  await selector.selectOption("__create_workspace__");

  const dialog = page.getByRole("dialog", { name: "새 워크스페이스 만들기" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("다음 화면에서 에이전트 한 명을 연결하거나 나중에 연결할 수 있습니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toBeHidden();
  await expect(selector).toHaveValue("settings-workspace-e2e");
});

test("moves only the current workspace to trash from workspace settings", async ({ page }) => {
  let trashRequest: unknown;
  await page.route("**/api/workspaces/settings-workspace-e2e/trash", async (route) => {
    trashRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "동작 검증을 위한 중단" }),
    });
  });

  await page.goto("/dev/settings-e2e");
  await page.getByRole("button", { name: "휴지통으로 이동" }).click();

  const dialog = page.getByRole("dialog", {
    name: "워크스페이스를 휴지통으로 옮길까요?",
  });
  const submit = dialog.getByRole("button", { name: "휴지통으로 이동" });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox").fill("James의 워크스페이스");
  await expect(submit).toBeEnabled();
  await submit.click();

  expect(trashRequest).toEqual({ confirmationName: "James의 워크스페이스" });
  await expect(dialog.getByText("동작 검증을 위한 중단")).toBeVisible();
});

test("finishes new-workspace onboarding in the new workspace without reopening the wizard", async ({ page }) => {
  await page.route("**/app?workspace=settings-workspace-e2e", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>workspace ready</title><main>workspace ready</main>",
    });
  });
  await page.goto("/dev/settings-e2e?connectAgent=1&workspaceOnboarding=1");

  const dialog = page.getByRole("dialog", { name: "James의 워크스페이스에 에이전트 연결" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "나중에 연결" }).click();

  await expect(page).toHaveURL(/\/app\?workspace=settings-workspace-e2e$/);
  await expect(page.getByText("workspace ready")).toBeVisible();
});

test("connects identity, workspace permissions, and a credential in one guided flow", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:3100",
  });
  let connectionRequest: unknown;
  await page.route("**/api/workspace-agents/connect", async (route) => {
    connectionRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          id: "agent-test-unassigned-e2e",
          displayName: "test",
          avatarMediaId: null,
          status: "active",
          deletedAt: null,
          purgeAfter: null,
          purgedAt: null,
          createdAt: "2026-07-16T03:00:00.000Z",
          updatedAt: "2026-07-18T02:00:00.000Z",
          credentials: [{
            id: "credential-test-e2e",
            name: "test 연결 키",
            prefix: "nyx_live_testkey",
            scopes: ["documents:read", "documents:write", "documents:commit", "changes:read", "revisions:restore"],
            defaultWorkspaceId: "settings-workspace-e2e",
            workspaceAllowlist: [],
            ipAllowlist: [],
            lastUsedAt: null,
            lastUsedIp: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: "2026-07-18T02:00:00.000Z",
          }],
          memberships: [],
        },
        membership: {
          membershipId: "membership-test-e2e",
          agentId: "agent-test-unassigned-e2e",
          workspaceId: "settings-workspace-e2e",
          workspaceName: "James의 워크스페이스",
          role: "editor",
          status: "active",
          permissionAllow: [],
          permissionDeny: [],
          effectivePermissions: ["workspace.read", "agents.read", "documents.read", "documents.create", "documents.update", "documents.commit"],
          rootDocumentId: null,
          rootDocumentTitle: null,
          createdAt: "2026-07-18T02:00:00.000Z",
          updatedAt: "2026-07-18T02:00:00.000Z",
        },
        credential: {
          id: "credential-test-e2e",
          name: "test 연결 키",
          prefix: "nyx_live_testkey",
          scopes: ["documents:read", "documents:write", "documents:commit", "changes:read", "revisions:restore"],
          defaultWorkspaceId: "settings-workspace-e2e",
          workspaceAllowlist: [],
          ipAllowlist: [],
          lastUsedAt: null,
          lastUsedIp: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-07-18T02:00:00.000Z",
        },
        token: "nyx_live_one_time_test_key",
        expandedCredentialWorkspaceAllowlist: false,
      }),
    });
  });

  await page.goto("/dev/settings-e2e?connectAgent=1");
  const dialog = page.getByRole("dialog", { name: "James의 워크스페이스에 에이전트 연결" });
  await expect(dialog).toBeVisible();
  await dialog.getByText("test", { exact: true }).click();
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(dialog.getByRole("radio", { name: /에디터/ })).toBeChecked();
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(dialog.getByText("새 연결 키 만들기", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "에이전트 연결", exact: true }).click();

  await expect(page.getByRole("dialog", { name: "연결이 준비됐습니다." })).toBeVisible();
  const handoffButton = page.getByRole("button", { name: "에이전트 연결 안내 전체 복사" });
  await expect(handoffButton).toBeVisible();
  await expect(page.getByText("사용하는 에이전트의 대화창에 붙여넣으면 연결 정보와 확인 절차를 한 번에 전달합니다.")).toBeVisible();
  await handoffButton.click();
  await expect(page.getByRole("button", { name: "안내 전체가 복사됐습니다" })).toBeVisible();
  await expect(page.getByText("nyx_live_one_time_test_key", { exact: true })).toBeVisible();
  await page.getByText("직접 설정하기 · MCP 주소와 앱별 예시").click();
  await expect(page.getByText(/workspace=settings-workspace-e2e/).first()).toBeVisible();
  expect(connectionRequest).toEqual({
    agent: { mode: "existing", agentId: "agent-test-unassigned-e2e" },
    role: "editor",
    rootDocumentId: null,
    credential: {
      mode: "new",
      name: "test 연결 키",
      restrictToWorkspace: false,
    },
  });

  await page.getByRole("button", { name: "완료", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/connectAgent=1/);
});

test("renames a registered agent inline without a browser prompt", async ({ page }) => {
  let patchBody: unknown;
  await page.route("**/api/account/agents/agent-gameroom-main-e2e", async (route) => {
    patchBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          id: "agent-gameroom-main-e2e",
          displayName: "gameroom-renamed",
          avatarMediaId: null,
          status: "active",
          deletedAt: null,
          purgeAfter: null,
          purgedAt: null,
          createdAt: "2026-07-15T01:00:00.000Z",
          updatedAt: "2026-07-17T01:00:00.000Z",
          credentials: [],
          memberships: [],
        },
      }),
    });
  });

  await page.goto("/dev/settings-e2e?area=agents");
  await page.getByRole("button", { name: "gameroom-main 이름 변경" }).click();

  const editor = page.getByRole("textbox", { name: "에이전트 이름", exact: true });
  await expect(editor).toHaveValue("gameroom-main");
  await editor.fill("gameroom-renamed");
  await editor.press("Enter");

  await expect(page.locator("#agent-identities").getByText("gameroom-renamed", { exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);
  expect(patchBody).toEqual({ displayName: "gameroom-renamed" });
});

test("shows the current agent status and switches its color with the state", async ({ page }) => {
  const statusUpdates: unknown[] = [];
  await page.route("**/api/account/agents/agent-gameroom-main-e2e", async (route) => {
    const update = route.request().postDataJSON() as { status: "active" | "disabled" };
    statusUpdates.push(update);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          id: "agent-gameroom-main-e2e",
          displayName: "gameroom-main",
          avatarMediaId: null,
          status: update.status,
          deletedAt: null,
          purgeAfter: null,
          purgedAt: null,
          createdAt: "2026-07-15T01:00:00.000Z",
          updatedAt: "2026-07-17T04:00:00.000Z",
          credentials: [],
          memberships: [],
        },
      }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/dev/settings-e2e?area=agents");
  const agent = page.getByRole("article").filter({ has: page.getByText("gameroom-main", { exact: true }) });
  const activeStatus = agent.getByRole("button", {
    name: "gameroom-main 활성 상태, 누르면 비활성 상태로 변경",
  });
  await expect(activeStatus).toHaveText("활성 상태");
  await expect(activeStatus).toHaveAttribute("aria-pressed", "true");
  await expect(activeStatus).toHaveCSS("background-color", "rgb(231, 241, 255)");
  await activeStatus.click();

  const disabledStatus = agent.getByRole("button", {
    name: "gameroom-main 비활성 상태, 누르면 활성 상태로 변경",
  });
  await expect(disabledStatus).toHaveText("비활성 상태");
  await expect(disabledStatus).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await expect(disabledStatus).toHaveCSS("background-color", "rgb(240, 242, 241)");
  await disabledStatus.click();

  await expect(activeStatus).toBeVisible();
  expect(statusUpdates).toEqual([{ status: "disabled" }, { status: "active" }]);
});

test("explains an unassigned agent and exposes every workspace from key creation", async ({ page }) => {
  await page.goto("/dev/settings-e2e?area=agents");

  const testAgent = page.getByRole("article").filter({ has: page.getByText("test", { exact: true }) });
  await testAgent.getByRole("button", { name: "키 만들기" }).click();

  const keyDialog = page.getByRole("dialog", { name: "새 연결 키 만들기" });
  const workspaceSelect = keyDialog.getByLabel("기본 워크스페이스");
  await expect(workspaceSelect).toHaveValue("");
  await expect(workspaceSelect.getByRole("option", { name: "배정된 워크스페이스 없음" })).toHaveText("배정된 워크스페이스 없음");
  await expect(workspaceSelect.getByRole("option", { name: "James의 워크스페이스 · 미배정" })).toHaveAttribute("disabled", "");
  await expect(workspaceSelect.getByRole("option", { name: "gameroom · 미배정" })).toHaveAttribute("disabled", "");
  await expect(keyDialog.getByText("먼저 워크스페이스에 배정해주세요.")).toBeVisible();

  await keyDialog.getByRole("button", { name: "배정·권한 보기" }).click();

  const assignmentDialog = page.getByRole("dialog", { name: "test의 배정·권한" });
  await expect(assignmentDialog).toBeVisible();
  await expect(assignmentDialog.getByText("James의 워크스페이스", { exact: true })).toBeVisible();
  await expect(assignmentDialog.getByText("gameroom", { exact: true })).toBeVisible();
  await expect(assignmentDialog.getByText("제품 문서", { exact: true })).toBeVisible();
  await expect(assignmentDialog.getByText("워크스페이스 관리자 역할은 유지됩니다.")).toBeVisible();
  await expect(assignmentDialog.getByRole("link", { name: "연결 시작" })).toHaveCount(3);
});

test("presents organizations as a separate namespace with explicit people, teams, and workspace access", async ({ page }) => {
  await page.goto("/dev/settings-e2e?area=organization");

  await expect(page.getByRole("heading", { name: "Junglan Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "조직 정보", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "사람과 초대", exact: true })).toBeVisible();
  await expect(page.getByText("조직 멤버십은 사람의 소속만 나타냅니다. 이것만으로 문서 접근 권한이 생기지는 않습니다.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "팀", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "워크스페이스 접근 권한", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "조직 감사 기록", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "조직 삭제", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "삭제된 조직", exact: true })).toBeVisible();
  await expect(page.getByText("James · 나", { exact: true })).toBeVisible();
  await expect(page.getByText("Documentation", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("제품 문서", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("docs-main", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Archived Lab", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "복구", exact: true })).toBeVisible();
});

test("creates a new organization from the organization selector and opens its settings", async ({ page }) => {
  const organizationId = "10000000-0000-4000-8000-000000000088";
  let createRequest: unknown;
  await page.route("**/api/organizations", async (route) => {
    createRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        organization: {
          id: organizationId,
          name: "Open Docs",
          icon: "OD",
        },
      }),
    });
  });
  await page.route(
    `**/settings/organization?workspace=settings-workspace-e2e&organization=${organizationId}**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>organization created</title><main>organization created</main>",
      });
    },
  );

  await page.goto("/dev/settings-e2e?area=organization");
  await page.getByLabel("현재 조직").selectOption("__create_organization__");
  const dialog = page.getByRole("dialog", { name: "새 조직 만들기" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("조직 이름").fill("Open Docs");
  await dialog.getByLabel("아이콘 (선택)").fill("OD");
  await dialog.getByRole("button", { name: "조직 만들기" }).click();

  await expect.poll(() => createRequest).toEqual({ name: "Open Docs", icon: "OD" });
  await expect(page.getByText("organization created")).toBeVisible();
});

test("sends organization profile, invitation, team, and workspace grant changes to their scoped APIs", async ({ page }) => {
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const requests: Record<string, unknown> = {};
  await page.route(`**/api/organizations/${organizationId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests.profile = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ organization: { id: organizationId } }),
    });
  });
  await page.route(`**/api/organizations/${organizationId}/invitations`, async (route) => {
    requests.invitation = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        invitation: { id: "new-invitation" },
        token: "one-time-test-token",
        url: "https://app.nyxdoc.com/organization-invite?invite=one-time-test-token",
      }),
    });
  });
  await page.route(`**/api/organizations/${organizationId}/teams`, async (route) => {
    requests.team = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ team: { id: "new-team" } }),
    });
  });
  await page.route(`**/api/organizations/${organizationId}/workspace-grants`, async (route) => {
    requests.grant = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ grant: { id: "updated-grant" } }),
    });
  });

  await page.goto("/dev/settings-e2e?area=organization");
  const general = page.locator("#organization-general");
  await general.getByLabel("조직 이름").fill("Junglan Docs");
  await general.getByLabel("짧은 아이콘").fill("📚");
  await general.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => requests.profile).toEqual({ name: "Junglan Docs", icon: "📚" });

  const people = page.locator("#organization-members");
  await people.getByLabel("이메일 (비우면 일회용 링크 초대)").fill("writer@example.com");
  await people.getByLabel("조직 역할").selectOption("member");
  await people.getByRole("button", { name: "초대 만들기" }).click();
  await expect.poll(() => requests.invitation).toEqual({
    email: "writer@example.com",
    role: "member",
  });
  await expect(people.getByText("https://app.nyxdoc.com/organization-invite?invite=one-time-test-token", { exact: true })).toBeVisible();

  const teams = page.locator("#organization-teams");
  await teams.getByLabel("팀 이름").first().fill("Research");
  await teams.getByLabel("설명 (선택)").first().fill("리서치 문서 담당");
  await teams.getByRole("button", { name: "팀 만들기" }).click();
  await expect.poll(() => requests.team).toEqual({
    name: "Research",
    description: "리서치 문서 담당",
  });

  const workspace = page.locator("#organization-workspaces article").filter({
    has: page.getByText("제품 문서", { exact: true }),
  }).first();
  await workspace.locator("select").nth(1).selectOption("admin");
  await expect.poll(() => requests.grant).toEqual({
    principalType: "team",
    principalId: "10000000-0000-4000-8000-000000000003",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    role: "admin",
  });
});

test("creates organization-owned workspaces and protects organization trash with exact-name confirmation", async ({ page }) => {
  let workspaceRequest: unknown;
  let trashRequest: unknown;
  await page.route("**/api/workspaces", async (route) => {
    workspaceRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        workspace: {
          id: "10000000-0000-4000-8000-000000000099",
          name: "Company Handbook",
        },
      }),
    });
  });
  await page.route("**/settings/workspace?workspace=10000000-0000-4000-8000-000000000099**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>organization workspace ready</title><main>organization workspace ready</main>",
    });
  });
  await page.goto("/dev/settings-e2e?area=organization");
  await page.getByRole("button", { name: "조직 워크스페이스 만들기" }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "새 워크스페이스 만들기" });
  await expect(workspaceDialog.getByText("Junglan Studio", { exact: true })).toBeVisible();
  await expect(workspaceDialog.getByText("조직 · 조직 멤버도 별도 접근 권한 필요", { exact: true })).toBeVisible();
  await workspaceDialog.getByLabel("워크스페이스 이름").fill("Company Handbook");
  await workspaceDialog.getByRole("button", { name: "다음: 에이전트 연결" }).click();
  await expect.poll(() => workspaceRequest).toEqual({
    name: "Company Handbook",
    organizationId: "10000000-0000-4000-8000-000000000001",
  });
  await expect(page.getByText("organization workspace ready")).toBeVisible();

  await page.route("**/api/organizations/10000000-0000-4000-8000-000000000001", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    trashRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "동작 검증을 위한 중단" }),
    });
  });
  await page.goto("/dev/settings-e2e?area=organization");
  await page.locator("#organization-danger").getByRole("button", { name: "휴지통으로 이동" }).click();
  const trashDialog = page.getByRole("dialog", { name: "조직 삭제" });
  const trashButton = trashDialog.getByRole("button", { name: "휴지통으로 이동" });
  await expect(trashButton).toBeDisabled();
  await trashDialog.getByRole("textbox").fill("Junglan Studio");
  await expect(trashButton).toBeEnabled();
  await trashButton.click();
  await expect.poll(() => trashRequest).toEqual({ confirmationName: "Junglan Studio" });
  await expect(page.getByText("동작 검증을 위한 중단", { exact: true })).toBeVisible();
});

test("keeps organization settings usable on a narrow portrait display", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto("/dev/settings-e2e?area=organization");

  await expect(page.getByRole("heading", { name: "Junglan Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "사람과 초대", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "워크스페이스 접근 권한", exact: true })).toBeVisible();
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
});

test("keeps assigned workspaces selectable and exposes the workspace administrator role", async ({ page }) => {
  let permissionUpdate: unknown;
  await page.route("**/api/workspace-agents/agent-gameroom-main-e2e", async (route) => {
    permissionUpdate = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        membership: {
          membershipId: "membership-james-e2e",
          agentId: "agent-gameroom-main-e2e",
          workspaceId: "settings-workspace-e2e",
          workspaceName: "James의 워크스페이스",
          role: "admin",
          status: "active",
          permissionAllow: [],
          permissionDeny: [],
          effectivePermissions: [
            "workspace.read",
            "agents.read",
            "documents.read",
            "documents.create",
            "documents.update",
            "documents.commit",
            "admin_requests.read",
            "admin_requests.create",
          ],
          rootDocumentId: null,
          rootDocumentTitle: null,
          createdAt: "2026-07-15T01:00:00.000Z",
          updatedAt: "2026-07-17T06:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dev/settings-e2e?area=agents");

  const gameroomAgent = page.getByRole("article").filter({ has: page.getByText("gameroom-main", { exact: true }) });
  await gameroomAgent.getByRole("button", { name: "키 만들기" }).click();
  const keyDialog = page.getByRole("dialog", { name: "새 연결 키 만들기" });
  const workspaceSelect = keyDialog.getByLabel("기본 워크스페이스");
  await expect(workspaceSelect.getByRole("option", { name: "James의 워크스페이스" })).toBeEnabled();
  await expect(workspaceSelect.getByRole("option", { name: "gameroom" })).toBeEnabled();

  await keyDialog.getByRole("button", { name: "취소" }).click();
  await page.goto("/dev/settings-e2e");

  await page.getByRole("button", { name: "에이전트 연결", exact: true }).click();
  const connectionDialog = page.getByRole("dialog", { name: "James의 워크스페이스에 에이전트 연결" });
  await connectionDialog.getByText("test", { exact: true }).click();
  await connectionDialog.getByRole("button", { name: "다음" }).click();
  await expect(connectionDialog.getByRole("radio", { name: /워크스페이스 관리자/ })).toBeEnabled();
  await connectionDialog.getByRole("button", { name: "에이전트 연결 닫기" }).click();

  await page.getByRole("button", { name: "권한 설정" }).click();
  const permissionDialog = page.getByRole("dialog", { name: "gameroom-main · James의 워크스페이스" });
  await permissionDialog.getByLabel("역할 묶음").selectOption("admin");
  await expect(permissionDialog.getByLabel("역할 묶음")).toHaveValue("admin");
  await permissionDialog.getByText("세부 권한 조정").click();
  await expect(permissionDialog.getByText("에이전트 자신의 키 발급, 보호 권한 추가, 영구 삭제, 소유권 이전은 이 역할에 포함되지 않으며 사람만 처리합니다.")).toBeVisible();
  await permissionDialog.getByRole("button", { name: "권한 저장" }).click();

  await expect(permissionDialog).toHaveCount(0);
  expect(permissionUpdate).toEqual({
    role: "admin",
    rootDocumentId: null,
    permissionAllow: [],
    permissionDeny: [],
    status: "active",
  });
});

test("deletes an agent with an explicit safety dialog and restores identity only", async ({ page }) => {
  const baseAgent = {
    id: "agent-test-unassigned-e2e",
    displayName: "test",
    avatarMediaId: null,
    status: "disabled" as const,
    deletedAt: "2026-07-17T03:00:00.000Z",
    purgeAfter: "2026-08-16T03:00:00.000Z",
    purgedAt: null,
    createdAt: "2026-07-16T03:00:00.000Z",
    updatedAt: "2026-07-17T03:00:00.000Z",
    credentials: [],
    memberships: [],
  };
  await page.route("**/api/account/agents/agent-test-unassigned-e2e", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agent: baseAgent }),
    });
  });
  await page.route("**/api/account/agents/agent-test-unassigned-e2e/restore", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          ...baseAgent,
          status: "active",
          deletedAt: null,
          purgeAfter: null,
          updatedAt: "2026-07-17T03:10:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dev/settings-e2e?area=agents");
  const testAgent = page.getByRole("article").filter({ has: page.getByText("test", { exact: true }) });
  await testAgent.getByRole("button", { name: "삭제", exact: true }).click();

  const deleteDialog = page.getByRole("dialog", { name: "test 삭제" });
  await expect(deleteDialog.getByText("모든 연결 키가 즉시 폐기되고 워크스페이스 할당이 중지됩니다.", { exact: false })).toBeVisible();
  await expect(deleteDialog.getByText("과거 기록은 안전하게 남습니다.")).toBeVisible();
  const confirmDelete = deleteDialog.getByRole("button", { name: "에이전트 삭제" });
  await expect(confirmDelete).toHaveCSS("background-color", "rgb(174, 103, 88)");
  await confirmDelete.click();

  await page.getByRole("heading", { name: "삭제된 에이전트", exact: true }).scrollIntoViewIfNeeded();
  const deletedRow = page.getByRole("article").filter({ has: page.getByText("test", { exact: true }) });
  await expect(deletedRow.getByText("연결 키는 폐기되었고 워크스페이스 할당과 담당은 중지되었습니다.")).toBeVisible();
  await deletedRow.getByRole("button", { name: "복구", exact: true }).click();

  await expect(page.getByRole("button", { name: "test 이름 변경" })).toBeVisible();
  await expect(page.locator("#deleted-agents").getByRole("article").filter({ has: page.getByText("test", { exact: true }) })).toHaveCount(0);
});
