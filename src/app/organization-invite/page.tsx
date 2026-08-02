import { OrganizationInviteCard } from "@/components/organizations/organization-invite-card";
import { getCurrentSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { getRequestLocale } from "@/lib/i18n/server";
import { getActiveOrganizationInvitation } from "@/lib/organizations/service";

export const dynamic = "force-dynamic";

export default async function OrganizationInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const locale = await getRequestLocale();
  const token = (await searchParams).invite?.trim() ?? "";
  const invitation = getActiveOrganizationInvitation(sqlite, token);
  if (!invitation) {
    const copy = {
      en: {
        title: "This organization invitation is not available.",
        description: "Check whether the link has already been used, revoked, or expired.",
      },
      ko: {
        title: "사용할 수 없는 조직 초대입니다.",
        description: "이미 사용했거나 취소·만료된 링크인지 확인해주세요.",
      },
      ja: {
        title: "この組織への招待は利用できません。",
        description: "リンクが使用済み、取り消し済み、または期限切れでないか確認してください。",
      },
    }[locale];
    return <main><section style={{ maxWidth: 620, margin: "10vh auto", padding: 32 }}>
      <h1>{copy.title}</h1>
      <p>{copy.description}</p>
    </section></main>;
  }
  const session = await getCurrentSession();
  const emailMismatch = Boolean(
    session && invitation.email && session.user.email.toLowerCase() !== invitation.email,
  );
  return <main>
    <OrganizationInviteCard
      authenticated={Boolean(session)}
      emailMismatch={emailMismatch}
      invitation={invitation}
      token={token}
    />
  </main>;
}
