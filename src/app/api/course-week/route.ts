import { NextRequest, NextResponse } from "next/server";

const COURSE_TIME_ORIGIN = "https://jwxk.ucas.ac.cn";
const COURSE_TIME_PATH = "/course/coursetime/";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CourseWeekSession = {
	weekday: string;
	weeks: number[];
};

type CourseWeekDetail = {
	courseTimeId: string;
	courseName: string;
	semesterName: string;
	lastWeek: number;
	sessions: CourseWeekSession[];
};

const cache = new Map<string, { cachedAt: number; detail: CourseWeekDetail }>();

function json(body: unknown, status = 200) {
	return NextResponse.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"X-Frame-Options": "DENY"
		}
	});
}

function isSameOriginRequest(req: NextRequest): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	const host = req.headers.get("host");
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeName(value: string): string {
	return value.replace(/[\s（）()【】\[\]《》<>·,，。！？!?:：;；、-]/g, "").toLowerCase();
}

function toWeekday(value: string): string | null {
	const matched = value.match(/星期([一二三四五六日天])/);
	if (!matched) return null;
	return `周${matched[1] === "天" ? "日" : matched[1]}`;
}

function parseWeeks(value: string): number[] {
	const weeks = new Set<number>();
	for (const matched of value.matchAll(/(\d{1,2})\s*(?:-|－|—|~|～|至|到)\s*(\d{1,2})|\d{1,2}/g)) {
		const [text, startText, endText] = matched;
		if (startText && endText) {
			const start = Number(startText);
			const end = Number(endText);
			if (start >= 1 && end <= 40 && start <= end) {
				for (let week = start; week <= end; week += 1) weeks.add(week);
			}
			continue;
		}
		const week = Number(text);
		if (week >= 1 && week <= 40) weeks.add(week);
	}
	return [...weeks].sort((a, b) => a - b);
}

function parseCourseTimePage(courseTimeId: string, html: string): CourseWeekDetail | null {
	const nameFromParagraph = html.match(/课程名称\s*[：:]\s*([^<\n]+)/i)?.[1] ?? "";
	const semesterName = stripHtml(html.match(/<p>\s*([^<]*学年[^<]*学期[^<]*)<\/p>/i)?.[1] ?? "");
	const courseName = stripHtml(nameFromParagraph);
	if (!courseName) return null;

	const rows = [...html.matchAll(/<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)]
		.map((matched) => ({ label: stripHtml(matched[1]), value: stripHtml(matched[2]) }));
	const sessions: CourseWeekSession[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index].label !== "上课时间") continue;
		const weekday = toWeekday(rows[index].value);
		const weekRow = rows.slice(index + 1, index + 4).find((row) => row.label === "上课周次");
		const weeks = weekRow ? parseWeeks(weekRow.value) : [];
		if (weekday && weeks.length > 0) sessions.push({ weekday, weeks });
	}
	const lastWeek = Math.max(0, ...sessions.flatMap((session) => session.weeks));
	return lastWeek > 0 ? { courseTimeId, courseName, semesterName, lastWeek, sessions } : null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
	if (!isSameOriginRequest(req)) return json({ message: "非法来源请求" }, 403);
	if (!req.headers.get("content-type")?.includes("application/json")) return json({ message: "请求格式错误" }, 415);

	let body: { courseTimeId?: unknown; expectedCourseName?: unknown };
	try {
		body = await req.json();
	} catch {
		return json({ message: "请求体 JSON 格式错误" }, 400);
	}

	const courseTimeId = String(body.courseTimeId ?? "").trim();
	const expectedCourseName = String(body.expectedCourseName ?? "").trim();
	if (!/^\d{1,9}$/.test(courseTimeId) || !expectedCourseName || expectedCourseName.length > 100) {
		return json({ message: "教务课程编号或课程名称格式错误" }, 400);
	}

	const cached = cache.get(courseTimeId);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		if (normalizeName(cached.detail.courseName) !== normalizeName(expectedCourseName)) return json({ message: "教务课程名称与当前课程不匹配" }, 422);
		return json(cached.detail);
	}

	try {
		const response = await fetch(`${COURSE_TIME_ORIGIN}${COURSE_TIME_PATH}${courseTimeId}`, {
			headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
			cache: "no-store",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (!response.ok) return json({ message: "教务课程时间页暂不可访问" }, 502);
		const detail = parseCourseTimePage(courseTimeId, await response.text());
		if (!detail) return json({ message: "未能从教务课程时间页解析上课周次" }, 502);
		if (normalizeName(detail.courseName) !== normalizeName(expectedCourseName)) return json({ message: "教务课程名称与当前课程不匹配" }, 422);
		cache.set(courseTimeId, { cachedAt: Date.now(), detail });
		return json(detail);
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") return json({ message: "教务课程时间页请求超时" }, 504);
		return json({ message: "教务课程时间页请求失败" }, 502);
	}
}
