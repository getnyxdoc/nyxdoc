import { z } from "zod";

const domainSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export const updateSiteSettingsSchema = z.object({
  expectedVersion: z.number().int().min(0),
  publicBaseUrl: z.string().trim().url().max(500).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "사이트 주소는 http:// 또는 https:// 주소여야 합니다."),
  registrationMode: z.enum(["invite", "open"]),
  emailVerificationEnabled: z.boolean(),
  emailDomainPolicy: z.enum(["restricted", "any"]),
  allowedEmailDomains: z.array(domainSchema).max(20),
  smtp: z.object({
    host: z.string().trim().max(253),
    port: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    user: z.string().trim().max(320),
    from: z.string().trim().max(320),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.emailDomainPolicy === "restricted" && value.allowedEmailDomains.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["allowedEmailDomains"],
      message: "이메일 도메인 제한을 사용하려면 허용 도메인을 하나 이상 입력해주세요.",
    });
  }
});
