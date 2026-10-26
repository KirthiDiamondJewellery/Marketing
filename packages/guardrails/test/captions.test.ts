import { describe, expect, it } from "vitest";
import { composeCaption, validateCaptions, validateHashtags, xLength, type CaptionContext } from "../src/index.ts";
import { codes, validCaptions, warnCodes } from "./fixtures.ts";

const ctx: CaptionContext = { ctaType: "comment_keyword", keyword: "blueprint", bannedPhrases: ["dream home"] };
type Caps = ReturnType<typeof validCaptions>;

describe("validateCaptions", () => {
  it("passes the valid fixture", () => {
    const r = validateCaptions(validCaptions(), ctx);
    expect(r.errors).toEqual([]);
  });

  const cases: [string, (c: Caps) => unknown, Partial<CaptionContext>, string[]][] = [
    ["extra key", (c) => ({ ...c, pinterest: { caption: "x" } }), {}, ["captions.shape"]],
    ["extra field", (c) => ({ ...c, instagram: { ...c.instagram, cta: "x" } }), {}, ["captions.shape"]],
    ["missing platform", (c) => ({ ...c, x: undefined }), {}, ["captions.missing_platform"]],
    ["IG without keyword", (c) => ({ ...c, instagram: { ...c.instagram, caption: "Budgets break early. Link in bio." } }), {}, ["captions.instagram_keyword"]],
    ["TikTok with comment keyword", (c) => ({ ...c, tiktok: { ...c.tiktok, caption: "Comment BLUEPRINT for the checklist." } }), {}, ["captions.offplatform_cta", "captions.comment_keyword_off_instagram"]],
    ["YouTube without DM or link", (c) => ({ ...c, youtube: { ...c.youtube, description: "Three things to get in writing." } }), {}, ["captions.offplatform_cta"]],
    ["YouTube DM me WORD", (c) => ({ ...c, youtube: { ...c.youtube, description: "DM me BLUEPRINT for the checklist." } }), {}, []],
    ["LinkedIn asks to comment the keyword", (c) => ({ ...c, linkedin: { ...c.linkedin, text: "Comment BLUEPRINT below." } }), {}, ["captions.comment_keyword_off_instagram"]],
    ["Facebook comment allowed with automation", (c) => ({ ...c, facebook: { ...c.facebook, caption: "Comment BLUEPRINT below." } }), { facebookCommentKeyword: true }, []],
    ["YT title 100 chars", (c) => ({ ...c, youtube: { ...c.youtube, title: "a".repeat(100) } }), {}, ["captions.youtube_title_length"]],
    ["YT title 99 chars", (c) => ({ ...c, youtube: { ...c.youtube, title: "a".repeat(99) } }), {}, []],
    ["X over 280 with link", (c) => ({ ...c, x: { text: `${"a".repeat(250)} https://example.com/a/very/long/path/that/is/long`, hashtags: ["#designbuild"] } }), {}, ["captions.too_long"]],
    ["X 280 exactly with link weight", (c) => ({ ...c, x: { text: `${"a".repeat(243)} https://example.com/a/very/long/path/that/is/long`, hashtags: ["#designbuild"] } }), {}, []],
    ["too few hashtags", (c) => ({ ...c, instagram: { ...c.instagram, hashtags: ["#designbuild"] } }), {}, ["hashtags.count"]],
    ["too many hashtags", (c) => ({ ...c, tiktok: { ...c.tiktok, hashtags: ["#a1", "#a2", "#a3", "#a4", "#a5", "#a6"] } }), {}, ["hashtags.count"]],
    ["bad hashtag", (c) => ({ ...c, tiktok: { ...c.tiktok, hashtags: ["#design-build", "#kitchenremodel", "#remodelingtips"] } }), {}, ["hashtags.format"]],
    ["duplicate hashtag", (c) => ({ ...c, tiktok: { ...c.tiktok, hashtags: ["#designbuild", "#DesignBuild", "#remodelingtips"] } }), {}, ["hashtags.duplicate"]],
    ["inline hashtags", (c) => ({ ...c, facebook: { ...c.facebook, caption: "Link in bio. #designbuild" } }), {}, ["captions.inline_hashtags"]],
    ["banned phrase", (c) => ({ ...c, linkedin: { ...c.linkedin, text: "Plan your dream home right." } }), {}, ["captions.banned_phrase"]],
    ["dash", (c) => ({ ...c, facebook: { ...c.facebook, caption: "Budgets break \u2014 link in bio." } }), {}, ["captions.dash"]],
    ["keyword cta with no keyword", (c) => c, { keyword: null }, ["captions.keyword_missing"]],
    ["link in bio cta needs the line", (c) => ({ ...c, instagram: { ...c.instagram, caption: "Budgets break early." } }), { ctaType: "link_in_bio", keyword: null }, ["captions.link_in_bio_missing", "captions.link_in_bio_missing"]],
    ["only the required platforms", (c) => ({ instagram: c.instagram }), { platforms: ["instagram"] }, []],
  ];
  it.each(cases)("%s", (_name, mutate, over, expected) => {
    const r = validateCaptions(mutate(validCaptions()), { ...ctx, ...over });
    expect(codes(r)).toEqual(expected);
  });

  it("warns on links where they don't work and tags outside the pool", () => {
    const c = validCaptions();
    c.instagram.caption += " https://example.com";
    c.linkedin.text += " https://example.com";
    const r = validateCaptions(c, { ...ctx, hashtagPool: ["designbuild", "#kitchenremodel"] });
    expect(warnCodes(r)).toEqual(expect.arrayContaining(["captions.instagram_link", "captions.linkedin_link", "hashtags.not_in_pool"]));
  });
});

describe("helpers", () => {
  it("xLength counts links as 23", () => {
    expect(xLength("hi https://example.com/very/long/url/indeed")).toBe(3 + 23);
  });
  it("composeCaption joins hashtags", () => {
    expect(composeCaption("instagram", { caption: "Hi.", hashtags: ["#a", "#b"] })).toBe("Hi.\n\n#a #b");
    expect(composeCaption("x", { text: "Hi.", hashtags: ["#a"] })).toBe("Hi. #a");
    expect(composeCaption("youtube", { description: "Desc.", hashtags: [] })).toBe("Desc.");
  });
  it("validateHashtags flags generic tags", () => {
    expect(codes(validateHashtags(["#viral", "#designbuild", "#remodel"], { min: 3, max: 5 }))).toEqual(["hashtags.generic"]);
  });
});
