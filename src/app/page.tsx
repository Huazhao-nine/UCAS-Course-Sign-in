"use client";

import Image from "next/image";
import { FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type CourseItem = {
	id: string;
	uuid: string;
	courseName: string;
	teacherName: string;
	classroom: string;
	weekDay: string;
	classBeginTime: string;
	classEndTime: string;
	signStatus: string;
	scheduleDate?: string;
};

type QueryResponse = {
	date: string;
	total: number;
	courses: CourseItem[];
};

type WeekResponse = {
	weekStart: string;
	weekEnd: string;
	total: number;
	days: Array<{ date: string; courses: CourseItem[] }>;
};

type DirectSignResponse = {
	success?: boolean;
	message?: string;
	upstreamStatus?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
	};
};

type ThemeMode = "system" | "light" | "dark";
type StatusKind = "idle" | "loading" | "success" | "error" | "info";
type FeatureMode = "query" | "manual";
type ScheduleView = "day" | "week";
type ToastState = { kind: Exclude<StatusKind, "idle">; message: string };

type RepoStarsCache = {
	stars: number;
	repoUpdatedAt: string;
	updatedAt: number;
};

type WeekScheduleCache = {
	weekStart: string;
	cachedAt: number;
	days: WeekResponse["days"];
};

const REPO_STARS_CACHE_KEY = "ucas-repo-stars-cache-v1";
const REPO_STARS_CACHE_TTL_MS = 1000 * 60 * 30;
const WEEK_SCHEDULE_CACHE_PREFIX = "ucas-week-schedule-cache-v1:";
const AUTO_QR_TTL_MS = 5 * 1000;
const DOWNLOAD_QR_TTL_MS = 10 * 1000;
// UCAS 的 get_timestamp.do 与 stu_scan_sign.action 运行在不同服务器上，
// 两者时钟偏差约 3.5s。校准对齐了 timestamp API，需要减去缓冲才能被 sign API 接受。
const SIGN_TIMESTAMP_BUFFER_MS = 3 * 1000;

const SIGN_BASE_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";
const DEFAULT_TEST_USERNAME = (process.env.NEXT_PUBLIC_UCAS_TEST_USERNAME ?? "").trim();
const DEFAULT_TEST_PASSWORD = process.env.NEXT_PUBLIC_UCAS_TEST_PASSWORD ?? "";
const PERIODS = [
	{ n: 1, t: "8:30-9:15" },
	{ n: 2, t: "9:20-10:05" },
	{ n: 3, t: "10:25-11:10" },
	{ n: 4, t: "11:15-12:00" },
	{ n: 5, t: "13:30-14:15" },
	{ n: 6, t: "14:20-15:05" },
	{ n: 7, t: "15:25-16:10" },
	{ n: 8, t: "16:15-17:00" },
	{ n: 9, t: "17:05-17:50" },
	{ n: 10, t: "18:30-19:15" },
	{ n: 11, t: "19:20-20:05" },
	{ n: 12, t: "20:15-21:00" },
	{ n: 13, t: "21:05-21:50" }
] as const;

type QrSource =
	| {
			mode: "query";
			uuid: string;
			courseId: string;
	  }
	| {
			mode: "manual";
			identifier: string;
	  };

function getSavedThemeMode(): ThemeMode {
	if (typeof window === "undefined") {
		return "system";
	}
	const saved = window.localStorage.getItem("ucas-theme-mode");
	return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

function toYyyyMMdd(dateInput: string): string {
	return dateInput.replace(/-/g, "");
}

function toDateInput(compactDate: string): string {
	return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
}

function formatWeekday(compactDate: string): string {
	const value = new Date(`${toDateInput(compactDate)}T12:00:00`);
	return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][value.getDay()] ?? "";
}

function attachScheduleDates(days: WeekResponse["days"]): WeekResponse["days"] {
	return days.map((day) => ({
		...day,
		courses: day.courses.map((course) => ({ ...course, scheduleDate: toDateInput(day.date) }))
	}));
}

function getWeekCacheKey(username: string, weekStart: string): string {
	let hash = 2166136261;
	for (const char of username.trim()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `${WEEK_SCHEDULE_CACHE_PREFIX}${(hash >>> 0).toString(36)}:${weekStart}`;
}

function readWeekScheduleCache(username: string, weekStart: string): WeekScheduleCache | null {
	try {
		const raw = window.localStorage.getItem(getWeekCacheKey(username, weekStart));
		if (!raw) return null;
		const cache = JSON.parse(raw) as WeekScheduleCache;
		if (!Array.isArray(cache.days) || cache.weekStart !== weekStart || typeof cache.cachedAt !== "number") return null;
		return cache;
	} catch {
		return null;
	}
}

function writeWeekScheduleCache(username: string, weekStart: string, days: WeekResponse["days"]): void {
	try {
		window.localStorage.setItem(getWeekCacheKey(username, weekStart), JSON.stringify({ weekStart, cachedAt: Date.now(), days } satisfies WeekScheduleCache));
	} catch {}
}

function clearWeekScheduleCaches(): void {
	try {
		for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
			const key = window.localStorage.key(index);
			if (key?.startsWith(WEEK_SCHEDULE_CACHE_PREFIX)) window.localStorage.removeItem(key);
		}
	} catch {}
}

function formatCachedAt(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function getWeekStart(compactDate: string): string {
	const value = new Date(`${toDateInput(compactDate)}T12:00:00`);
	value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
	return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, "0")}${String(value.getDate()).padStart(2, "0")}`;
}

function getTodayInputDate(): string {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatRepoDate(isoDate: string): string {
	if (!isoDate) {
		return "";
	}
	const d = new Date(isoDate);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	const month = d.getMonth() + 1;
	const day = d.getDate();
	return `${month}.${String(day).padStart(2, "0")}`;
}

function parseClockToMinutes(value: string): number {
	const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
	if (!match) {
		return 0;
	}
	return Number(match[1]) * 60 + Number(match[2]);
}

type CoursePeriodRange = {
	start: number;
	end: number;
};

function getCoursePeriodRange(course: CourseItem): CoursePeriodRange | null {
	const start = parseClockToMinutes(course.classBeginTime);
	const end = parseClockToMinutes(course.classEndTime);
	if (!start || !end || end <= start) {
		return null;
	}

	const matched = PERIODS.filter((period) => {
		const [periodStart, periodEnd] = period.t.split("-").map(parseClockToMinutes);
		return start < periodEnd && end > periodStart;
	});
	if (matched.length === 0) {
		return null;
	}

	return { start: matched[0].n, end: matched[matched.length - 1].n };
}

function formatCoursePeriods(course: CourseItem): string {
	const range = getCoursePeriodRange(course);
	if (!range) {
		return "--";
	}

	const first = PERIODS[range.start - 1];
	const last = PERIODS[range.end - 1];
	const lesson = first.n === last.n ? `第 ${first.n} 节` : `第 ${first.n}-${last.n} 节`;
	return `${lesson}（${first.t}${first.n === last.n ? "" : `-${last.t.split("-")[1]}`}）`;
}

function buildSignInUrl(courseId: string, expiresAt: number): string {
	return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(courseId)}&timestamp=${expiresAt}`;
}

function buildManualSignInUrl(identifier: string, expiresAt: number): string | null {
	const raw = identifier.trim();
	if (!raw) {
		return null;
	}

	if (/^\d+$/.test(raw)) {
		return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(raw)}&timestamp=${expiresAt}`;
	}

	const compact = raw.replace(/-/g, "");
	if (/^[0-9a-fA-F]{32}$/.test(compact)) {
		return `${SIGN_BASE_URL}?timeTableId=${encodeURIComponent(compact.toUpperCase())}&timestamp=${expiresAt}`;
	}

	return null;
}

function getSignIdentifierForFilename(signUrl: string, selectedUuid: string): string {
	if (!signUrl) {
		return selectedUuid || "unknown";
	}

	try {
		const url = new URL(signUrl);
		const courseSchedId = url.searchParams.get("courseSchedId");
		if (courseSchedId) {
			return courseSchedId;
		}

		const timeTableId = url.searchParams.get("timeTableId");
		if (timeTableId) {
			return timeTableId;
		}

		return selectedUuid || "unknown";
	} catch {
		return selectedUuid || "unknown";
	}
}

function extractClockTime(value: string): string | null {
	if (!value) {
		return null;
	}
	const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
	if (!timeMatch) {
		return null;
	}
	return timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
}

function buildDateTimeFromClock(dateInput: string, clockTime: string | null): Date | null {
	if (!clockTime) {
		return null;
	}

	const parsed = new Date(`${dateInput}T${clockTime}`);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed;
}

function readRepoStarsCache(): RepoStarsCache | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(REPO_STARS_CACHE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as RepoStarsCache;
		if (
			typeof parsed?.stars !== "number" ||
			typeof parsed?.updatedAt !== "number" ||
			typeof parsed?.repoUpdatedAt !== "string"
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function writeRepoStarsCache(stars: number, repoUpdatedAt: string): void {
	if (typeof window === "undefined") {
		return;
	}

	try {
		const payload: RepoStarsCache = { stars, repoUpdatedAt, updatedAt: Date.now() };
		window.localStorage.setItem(REPO_STARS_CACHE_KEY, JSON.stringify(payload));
	} catch {}
}

export default function Home() {
	const repoUrl = "https://github.com/lccipher/UCAS-Course-Sign-in";
	const [themeMode, setThemeMode] = useState<ThemeMode>(getSavedThemeMode);
	const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
	const [repoStars, setRepoStars] = useState<number | null>(null);
	const [repoUpdatedAt, setRepoUpdatedAt] = useState<string>("");
	const [featureMode, setFeatureMode] = useState<FeatureMode>("query");
	const [username, setUsername] = useState(DEFAULT_TEST_USERNAME);
	const [password, setPassword] = useState(DEFAULT_TEST_PASSWORD);
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [manualIdentifier, setManualIdentifier] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [weeklyDays, setWeeklyDays] = useState<WeekResponse["days"]>([]);
	const [scheduleView, setScheduleView] = useState<ScheduleView>("day");
	const [weekCacheUpdatedAt, setWeekCacheUpdatedAt] = useState<number | null>(null);
	const [selectedUuid, setSelectedUuid] = useState("");
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [toast, setToast] = useState<ToastState | null>(null);
	const [loading, setLoading] = useState(false);
	const [manualLoading, setManualLoading] = useState(false);
	const [signingCourseUuid, setSigningCourseUuid] = useState("");
	const [signUrl, setSignUrl] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [expireAt, setExpireAt] = useState(0);
	const [expireCountdown, setExpireCountdown] = useState(0);
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const [qrSource, setQrSource] = useState<QrSource | null>(null);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);
	const toastTimerRef = useRef<number | null>(null);

	const showToast = (kind: StatusKind, message: string) => {
		if (toastTimerRef.current !== null) {
			window.clearTimeout(toastTimerRef.current);
		}
		if (kind === "idle") {
			setToast(null);
			return;
		}
		setToast({ kind, message });
		toastTimerRef.current = window.setTimeout(() => setToast(null), kind === "error" ? 6500 : 4200);
	};

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		showToast(kind, message);
	};

	const updateActionStatus = (kind: StatusKind, message: string) => {
		showToast(kind, message);
	};

	const timeOffsetRef = useRef<{ offset: number; fetchedAt: number } | null>(null);
	const OFFSET_TTL_MS = 30 * 1000;

	const getServerTimeOffset = async (): Promise<number> => {
		const cached = timeOffsetRef.current;
		if (cached && Date.now() - cached.fetchedAt < OFFSET_TTL_MS) {
			return cached.offset;
		}

		try {
			const start = Date.now();
			const res = await fetch("/api/course-uuid/timestamp", {
				cache: "no-store"
			});
			if (!res.ok) {
				throw new Error();
			}
			const data = await res.json();
			if (data.success && typeof data.timestamp === "number") {
				const latency = Math.max(0, Date.now() - start);
				const serverTime = data.timestamp + Math.floor(latency / 2);
				const offset = serverTime - Date.now();
				timeOffsetRef.current = { offset, fetchedAt: Date.now() };
				return offset;
			}
		} catch {}

		// 校准失败：优先用过期的缓存降级
		if (cached) return cached.offset;
		timeOffsetRef.current = { offset: 0, fetchedAt: Date.now() };
		return 0;
	};

	useEffect(() => {
		void getServerTimeOffset();
	}, []);

	useEffect(() => {
		return () => {
			if (toastTimerRef.current !== null) {
				window.clearTimeout(toastTimerRef.current);
			}
		};
	}, []);

	const resetGeneratedSignState = () => {
		setSelectedUuid("");
		setSigningCourseUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrRelayActive(false);
		setQrSource(null);
		setToast(null);
	};

	const getPayloadFromSource = (source: QrSource, deadline: number): string | null => {
		if (source.mode === "query") {
			return buildSignInUrl(source.courseId, deadline);
		}
		return buildManualSignInUrl(source.identifier, deadline);
	};

	const generateQrDataUrlFromPayload = async (payload: string): Promise<string> => {
		const { default: QRCode } = await import("qrcode");
		return QRCode.toDataURL(payload, {
			width: 320,
			margin: 1,
			errorCorrectionLevel: "M"
		});
	};

	const regenerateAutoQr = async (source: QrSource): Promise<boolean> => {
		const offset = await getServerTimeOffset();
		const currentTimestamp = Date.now() + offset;
		// 签到时间戳减去缓冲，弥补 UCAS 两台服务器间的时钟偏差
		const signTimestamp = currentTimestamp - SIGN_TIMESTAMP_BUFFER_MS;
		const payload = getPayloadFromSource(source, signTimestamp);
		if (!payload) {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			setSignUrl(payload);
			setExpireAt(currentTimestamp + AUTO_QR_TTL_MS);
			setQrDataUrl(imageUrl);
			return true;
		} catch {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}
	};

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");

		const applyTheme = () => {
			const resolved = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
			document.documentElement.setAttribute("data-theme", resolved);
			setResolvedTheme(resolved);
		};

		applyTheme();
		const onMediaChange = () => {
			if (themeMode === "system") {
				applyTheme();
			}
		};

		media.addEventListener("change", onMediaChange);
		window.localStorage.setItem("ucas-theme-mode", themeMode);

		return () => {
			media.removeEventListener("change", onMediaChange);
		};
	}, [themeMode]);

	useEffect(() => {
		const controller = new AbortController();
		const cached = readRepoStarsCache();

		if (cached) {
			setRepoStars(cached.stars);
			setRepoUpdatedAt(cached.repoUpdatedAt);
			if (Date.now() - cached.updatedAt < REPO_STARS_CACHE_TTL_MS) {
				return () => {
					controller.abort();
				};
			}
		}

		const loadRepoStars = async () => {
			try {
				const res = await fetch("https://api.github.com/repos/lccipher/UCAS-Course-Sign-in", {
					signal: controller.signal,
					headers: {
						Accept: "application/vnd.github+json"
					}
				});

				if (!res.ok) {
					return;
				}

				const data = (await res.json()) as { stargazers_count?: number; updated_at?: string };
				if (typeof data.stargazers_count === "number") {
					setRepoStars(data.stargazers_count);
					setRepoUpdatedAt(data.updated_at ?? "");
					writeRepoStarsCache(data.stargazers_count, data.updated_at ?? "");
				}
			} catch {}
		};

		void loadRepoStars();

		return () => {
			controller.abort();
		};
	}, []);

	useEffect(() => {
		if (!expireAt) {
			setExpireCountdown(0);
			return;
		}

		const updateCountdown = () => {
			const remainMs = expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0));
			setExpireCountdown(Math.max(0, Math.ceil(remainMs / 1000)));
		};

		updateCountdown();
		const timer = window.setInterval(updateCountdown, 250);

		return () => {
			window.clearInterval(timer);
		};
	}, [expireAt]);

	useEffect(() => {
		if (!qrSource || !expireAt) {
			return;
		}

		const delay = Math.max(0, expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0)));
		const timer = window.setTimeout(async () => {
			const ok = await regenerateAutoQr(qrSource);
			if (!ok) {
				if (qrSource.mode === "query") {
					updateActionStatus("error", "签到码自动刷新失败，请重新选择课程");
				} else {
					updateStatus("error", "签到码自动刷新失败，请重新生成");
				}
			}
		}, delay);

		return () => {
			window.clearTimeout(timer);
		};
	}, [qrSource, expireAt]);

	const deferredKeyword = useDeferredValue(keyword);

	const filteredCourses = useMemo(() => {
		const word = deferredKeyword.trim().toLowerCase();
		if (!word) {
			return courses;
		}
		return courses.filter((item) => {
			return item.courseName.toLowerCase().includes(word) || item.teacherName.toLowerCase().includes(word);
		});
	}, [courses, deferredKeyword]);

	const dailySchedule = useMemo(() => {
		const scheduled: Array<{ course: CourseItem; range: CoursePeriodRange }> = [];
		const unmatched: CourseItem[] = [];

		for (const course of filteredCourses) {
			const range = getCoursePeriodRange(course);
			if (range) {
				scheduled.push({ course, range });
			} else {
				unmatched.push(course);
			}
		}

		scheduled.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
		return { scheduled, unmatched };
	}, [filteredCourses]);

	const hasCourses = courses.length > 0;
	const hasWeeklyCourses = weeklyDays.some((day) => day.courses.length > 0);
	const hasQr = Boolean(qrDataUrl);
	const queryAttempted = statusKind !== "idle";
	const hasKeyword = keyword.trim().length > 0;
	const emptyHelpText = hasKeyword ? "可先清空筛选词，再查看全部课程" : "检查日期是否为上课日，并确认学号与密码正确";

	const queryCourses = async (skipWeekCache = false) => {
		const compactDate = toYyyyMMdd(date);
		const safeUsername = username.trim();
		const weekStart = getWeekStart(compactDate);
		if (scheduleView === "week" && !skipWeekCache && safeUsername) {
			const cache = readWeekScheduleCache(safeUsername, weekStart);
			if (cache) {
				setCourses([]);
				setWeeklyDays(attachScheduleDates(cache.days));
				setWeekCacheUpdatedAt(cache.cachedAt);
				updateStatus("success", `已载入本地缓存（${formatCachedAt(cache.cachedAt)}），可随时刷新本周`);
				return;
			}
		}

		setLoading(true);
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrSource(null);
		updateStatus("loading", "正在查询课程…");

		try {
			const res = await fetch("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: safeUsername,
					password,
					date: compactDate,
					week: scheduleView === "week"
				})
			});

			const data = (await res.json()) as (QueryResponse | WeekResponse) & { message?: string };

			if (!res.ok) {
				setCourses([]);
				setWeeklyDays([]);
				setWeekCacheUpdatedAt(null);
				updateStatus("error", data.message ?? "查询失败，请重试");
				return;
			}

			if (scheduleView === "week") {
				const weekData = data as WeekResponse;
				const cachedDays = weekData.days ?? [];
				setCourses([]);
				setWeeklyDays(attachScheduleDates(cachedDays));
				writeWeekScheduleCache(safeUsername, weekData.weekStart, cachedDays);
				setWeekCacheUpdatedAt(Date.now());
				updateStatus("success", `已查询到本周 ${weekData.total ?? 0} 门课程（${weekData.weekStart}-${weekData.weekEnd}）`);
			} else {
				const dayData = data as QueryResponse;
				setWeeklyDays([]);
				setWeekCacheUpdatedAt(null);
				setCourses(dayData.courses ?? []);
				updateStatus("success", `已查询到 ${dayData.total} 门课程（${dayData.date}）`);
			}
		} catch {
			setCourses([]);
			setWeeklyDays([]);
			setWeekCacheUpdatedAt(null);
			updateStatus("error", "网络异常，请稍后重试");
		} finally {
			setLoading(false);
		}
	};

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void queryCourses();
	};

	const onClearWeekCache = () => {
		clearWeekScheduleCaches();
		setWeekCacheUpdatedAt(null);
		updateActionStatus("info", "本地课表缓存已清除；再次查询将访问课表接口");
	};

	const onManualGenerate = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const source: QrSource = { mode: "manual", identifier: manualIdentifier };
		const payload = getPayloadFromSource(source, Date.now() + (timeOffsetRef.current?.offset ?? 0));

		if (!payload) {
			updateStatus("error", "请输入纯数字课程ID或32位UUID");
			return;
		}

		setManualLoading(true);
		setSelectedUuid("");
		setQrSource(source);

		let ok = false;
		try {
			ok = await regenerateAutoQr(source);
		} finally {
			setManualLoading(false);
		}

		if (!ok) {
			updateStatus("error", "签到码生成失败，请检查课程ID或UUID后重试");
			return;
		}

		updateStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	};

	const onDownloadQr = async () => {
		if (!qrSource) {
			return;
		}

		const offset = await getServerTimeOffset();
		const deadline = Date.now() + offset + DOWNLOAD_QR_TTL_MS;
		const payload = getPayloadFromSource(qrSource, deadline);
		if (!payload) {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请重新生成签到码");
				return;
			}
			updateStatus("error", "下载二维码失败，请重新生成签到码");
			return;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			const link = document.createElement("a");
			link.href = imageUrl;
			const safeIdentifier = getSignIdentifierForFilename(payload, selectedUuid);
			link.download = `ucas-signin-${safeIdentifier}-${deadline}.png`;
			link.click();
			if (featureMode === "query") {
				updateActionStatus("success", "二维码已开始下载（10秒有效）");
				return;
			}
			updateStatus("success", "二维码已开始下载（10秒有效）");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请稍后重试");
				return;
			}
			updateStatus("error", "下载二维码失败，请稍后重试");
		}
	};

	const onCopySignUrl = async () => {
		if (!signUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signUrl);
			if (featureMode === "query") {
				updateActionStatus("info", "已复制签到链接");
				return;
			}
			updateStatus("info", "已复制签到链接");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "复制签到链接失败，请手动复制");
				return;
			}
			updateStatus("error", "复制签到链接失败，请手动复制");
		}
	};

	const refreshCoursesAfterSign = async (): Promise<{ ok: true; total: number } | { ok: false }> => {
		try {
			const res = await fetch("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: username.trim(),
					password,
					date: toYyyyMMdd(date),
					week: scheduleView === "week"
				})
			});

			const data = (await res.json()) as (QueryResponse | WeekResponse) & { message?: string };
			if (!res.ok) {
				return { ok: false };
			}

			if (scheduleView === "week") {
				const weekData = data as WeekResponse;
				const cachedDays = weekData.days ?? [];
				setWeeklyDays(attachScheduleDates(cachedDays));
				writeWeekScheduleCache(username.trim(), weekData.weekStart, cachedDays);
				setWeekCacheUpdatedAt(Date.now());
				return { ok: true, total: weekData.total ?? 0 };
			}
			const dayData = data as QueryResponse;
			setCourses(dayData.courses ?? []);
			return { ok: true, total: dayData.total ?? dayData.courses.length };
		} catch {
			return { ok: false };
		}
	};

	const onCourseSign = async (course: CourseItem) => {
		const safeUsername = username.trim();
		if (!safeUsername || !password) {
			updateActionStatus("error", "请先输入学号和密码");
			return;
		}

		const courseDate = course.scheduleDate ?? date;
		const classBegin = buildDateTimeFromClock(courseDate, extractClockTime(course.classBeginTime));
		const classEnd = buildDateTimeFromClock(courseDate, extractClockTime(course.classEndTime));
		if (!classBegin || !classEnd) {
			updateActionStatus("error", "课程时间信息异常，暂不支持直接签到");
			return;
		}
		const now = Date.now() + (timeOffsetRef.current?.offset ?? 0);
		if (now < classBegin.getTime() - 30 * 60 * 1000 || now > classEnd.getTime()) {
			updateActionStatus("error", "当前不在签到时间（开课前30分钟至下课前可签到）");
			return;
		}

		setSigningCourseUuid(course.uuid);
		updateActionStatus("loading", "正在发起签到…");

		try {
			const offset = await getServerTimeOffset();
			const signTimestamp = Date.now() + offset - SIGN_TIMESTAMP_BUFFER_MS;

			const res = await fetch("/api/course-uuid/sign", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: safeUsername,
					password,
					courseSchedId: course.id,
					timestamp: signTimestamp
				})
			});

			const data = (await res.json()) as DirectSignResponse;

			if (!res.ok || !data.success) {
				updateActionStatus("error", data.message ?? "签到失败，请稍后重试");
				return;
			}

			const signIdText = data.result?.stuSignId ? `（签到记录 ${data.result.stuSignId}）` : "";
			const refreshed = await refreshCoursesAfterSign();
			if (refreshed.ok) {
				updateActionStatus("success", `${data.message ?? "签到成功"}${signIdText}，课程状态已刷新`);
			} else {
				updateActionStatus(
					"info",
					`${data.message ?? "签到成功"}${signIdText}，但课程状态刷新失败，请手动查询`
				);
			}
		} catch {
			updateActionStatus("error", "网络异常，签到请求未完成");
		} finally {
			setSigningCourseUuid("");
		}
	};

	const onToggleTheme = () => {
		setThemeMode(resolvedTheme === "dark" ? "light" : "dark");
	};

	return (
		<>
			<div className="grain flex min-h-screen flex-col px-4 py-7 sm:px-10">
				<main className="mx-auto w-full max-w-6xl">
					{toast ? (
						<div className={`toast-notification toast-notification--${toast.kind}`} role="status" aria-live={toast.kind === "error" ? "assertive" : "polite"} aria-atomic="true">
							<p>{toast.message}</p>
							<button type="button" onClick={() => setToast(null)} aria-label="关闭提示">×</button>
						</div>
					) : null}
					<header className="mb-7">
						<a href="#main-content" className="sr-only focus:not-sr-only skip-link">
							跳到主要内容
						</a>
						<div className="mt-4">
							<h1 className="max-w-4xl font-[var(--font-serif)] text-3xl leading-tight font-semibold sm:text-5xl">
								UCAS Course Sign in
							</h1>
						</div>
						<p className="mt-4 text-sm leading-7 sm:text-base">
							查询当天或本周课程后，可直接在课表中完成签到。也可以手动输入课程ID或UUID生成签到码。
						</p>
						<div className="utility-toolbar mt-4 flex flex-wrap items-center gap-2.5">
							<div className="repo-link-group inline-flex min-h-11 items-stretch">
								<a
									href={repoUrl}
									target="_blank"
									rel="noreferrer"
									className="repo-link-main inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold sm:text-sm"
									aria-label="查看 GitHub 仓库"
									title="查看 GitHub 仓库"
								>
									<svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
										<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.55 7.55 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
									</svg>
									<span>GitHub</span>
									<svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
										<path d="m10 1.5 2.42 4.9 5.4.78-3.9 3.8.92 5.37L10 13.9l-4.84 2.55.92-5.37-3.9-3.8 5.4-.78L10 1.5Z" />
									</svg>
									<span className="numeric-tabular">
										{repoStars !== null ? repoStars.toLocaleString() : "--"}
									</span>
									<svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
										<path
											fillRule="evenodd"
											d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z"
											clipRule="evenodd"
										/>
									</svg>
									<span className="numeric-tabular">{formatRepoDate(repoUpdatedAt)}</span>
								</a>
							</div>
							<button
								type="button"
								onClick={onToggleTheme}
								className="theme-toggle-compact inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold sm:text-sm"
								aria-pressed={resolvedTheme === "dark"}
								aria-label={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
								title={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
							>
								<svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-current">
									{resolvedTheme === "dark" ? (
										<path d="M12 3a1 1 0 0 1 1 1v1.2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 14.8a1 1 0 0 1 1 1V20a1 1 0 1 1-2 0v-1.2a1 1 0 0 1 1-1Zm8-5.8a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-1.2a1 1 0 1 1 0-2H20ZM5.2 12a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2h1.2Zm11.2-5.66a1 1 0 0 1 1.42 0l.85.85a1 1 0 1 1-1.41 1.42l-.86-.85a1 1 0 0 1 0-1.42Zm-10.24 0a1 1 0 0 1 1.42 1.42l-.86.85A1 1 0 0 1 5.33 7.2l.85-.85Zm11.39 10.24.85.85a1 1 0 1 1-1.41 1.42l-.86-.85a1 1 0 1 1 1.42-1.42Zm-10.24 0a1 1 0 0 1 0 1.42l-.86.85a1 1 0 1 1-1.41-1.42l.85-.85a1 1 0 0 1 1.42 0ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" />
									) : (
										<path d="M21.75 15.08a.75.75 0 0 0-.95-.46 8.23 8.23 0 0 1-2.62.43 8.24 8.24 0 0 1-8.23-8.23c0-.9.14-1.77.43-2.62a.75.75 0 0 0-.95-.95A9.75 9.75 0 1 0 21.3 16.03a.75.75 0 0 0 .45-.95Z" />
									)}
								</svg>
								<span>{resolvedTheme === "dark" ? "切换亮色" : "切换暗色"}</span>
							</button>
						</div>
						<div className="mt-4 flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("query");
									updateStatus("idle", "输入学号、密码和日期，开始查询课程");
								}}
								className={`action-btn min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold sm:text-sm ${
									featureMode === "query" ? "action-btn--primary" : "action-btn--secondary"
								}`}
							>
								查询课程模式
							</button>
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("manual");
									updateStatus("idle", "输入课程ID或UUID，直接生成签到码");
								}}
								className={`action-btn min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold sm:text-sm ${
									featureMode === "manual" ? "action-btn--primary" : "action-btn--secondary"
								}`}
							>
								手动生成模式
							</button>
						</div>
					</header>

					{featureMode === "query" ? (
						<section
							id="main-content"
							className="panel query-workspace rounded-2xl p-5 sm:p-6"
						>
							<form onSubmit={onSubmit}>
								<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
									<div>
										<h2 className="font-[var(--font-serif)] text-2xl font-semibold">查询课程</h2>
									<p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
										学号和密码仅用于本次查询，不会存储
									</p>
									</div>
								</div>

								<div className="query-toolbar mt-4 grid gap-3 md:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(150px,0.8fr)_auto] md:items-end">
									<label className="block text-sm font-semibold">
										学号
										<input
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="studentId"
											value={username}
											onChange={(e) => setUsername(e.target.value)}
											autoComplete="username"
											spellCheck={false}
											required
										/>
									</label>

									<label className="block text-sm font-semibold">
										密码
										<input
											type="password"
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="password"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											autoComplete="current-password"
											required
										/>
									</label>

									<label className="date-field block text-sm font-semibold">
										日期
										<div className="date-control mt-2">
											<input
												type="date"
												className="date-input focus-ring input-surface w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
												name="courseDate"
												value={date}
												onChange={(e) => setDate(e.target.value)}
												required
											/>
											<button
												type="button"
												className="date-today-btn"
												onClick={() => setDate(getTodayInputDate())}
												aria-label="将查询日期设为今天"
											>
												今天
											</button>
										</div>
										<span className="date-hint">当前查询：{date}</span>
									</label>

									<button
										disabled={loading}
										className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-5 py-2.5 text-sm font-semibold md:w-auto"
										type="submit"
									>
										{loading ? "查询中..." : "查询课程"}
									</button>
								</div>
								<div className="schedule-view-switch mt-3" role="group" aria-label="课表查询范围">
									<button type="button" onClick={() => { setScheduleView("day"); setCourses([]); setWeeklyDays([]); setWeekCacheUpdatedAt(null); updateStatus("idle", "将查询选定日期当天的课程"); }} className={scheduleView === "day" ? "schedule-view-switch__option schedule-view-switch__option--active" : "schedule-view-switch__option"} aria-pressed={scheduleView === "day"}>当日课表</button>
									<button type="button" onClick={() => { setScheduleView("week"); setCourses([]); setWeeklyDays([]); setWeekCacheUpdatedAt(null); updateStatus("idle", "将查询选定日期所在周（周一至周日）的课程"); }} className={scheduleView === "week" ? "schedule-view-switch__option schedule-view-switch__option--active" : "schedule-view-switch__option"} aria-pressed={scheduleView === "week"}>本周课表</button>
									<span>{scheduleView === "week" ? "一次登录查询周一至周日" : "仅查询所选日期"}</span>
								</div>

							</form>

							<div className="schedule-section mt-6 border-t border-[color:var(--line)] pt-5">
								<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
									<h2 className="font-[var(--font-serif)] text-2xl font-semibold">{scheduleView === "week" ? "本周课表" : "当日课表"}</h2>
									{scheduleView === "day" && hasCourses ? (
										<input
											className="focus-ring input-surface min-h-11 w-full rounded-xl border border-[color:var(--line)] px-4 py-2 text-sm md:w-auto md:min-w-[230px]"
											name="courseFilter"
											aria-label="筛选课程"
											value={keyword}
											onChange={(e) => setKeyword(e.target.value)}
											placeholder="输入课程名或教师姓名进行筛选"
										/>
									) : null}
									{scheduleView === "week" ? (
										<div className="weekly-cache-actions">
											{weekCacheUpdatedAt ? <span>缓存：{formatCachedAt(weekCacheUpdatedAt)}</span> : null}
											<button type="button" className="action-btn action-btn--secondary min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold" disabled={loading} onClick={() => void queryCourses(true)}>刷新本周</button>
											<button type="button" className="action-btn action-btn--quiet min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold" onClick={onClearWeekCache}>清除本地缓存</button>
										</div>
									) : null}
								</div>

								<div className="mt-4 space-y-3">
									{scheduleView === "week" ? (
										hasWeeklyCourses ? (
											<div className="weekly-schedule-wrap" aria-label="本周课程时间表">
												<div className="weekly-schedule-grid">
													<div className="weekly-schedule-corner">节次</div>
													{weeklyDays.map((day, index) => <div key={day.date} className={`weekly-schedule-day-header ${toDateInput(day.date) === date ? "weekly-schedule-day-header--today" : ""}`} style={{ gridColumn: index + 2 }}><strong>{formatWeekday(day.date)}</strong><span>{toDateInput(day.date).slice(5).replace("-", "/")}</span></div>)}
													{PERIODS.map((period) => <div key={period.n} className="weekly-schedule-period" style={{ gridRow: period.n + 1 }}><strong>{period.n}</strong><span>{period.t}</span></div>)}
													{PERIODS.flatMap((period) => weeklyDays.map((day, index) => <div key={`${day.date}-line-${period.n}`} className="weekly-schedule-line" style={{ gridColumn: index + 2, gridRow: period.n + 1 }} />))}
													{weeklyDays.flatMap((day, dayIndex) => day.courses.map((course) => {
														const range = getCoursePeriodRange(course);
														if (!range) return null;
														const signed = course.signStatus === "1";
														const courseKey = `${day.date}-${course.id}-${course.uuid}`;
														const signingThisCourse = signingCourseUuid === course.uuid;
														return <article key={courseKey} style={{ gridColumn: dayIndex + 2, gridRow: `${range.start + 1} / ${range.end + 2}` }} className={`weekly-grid-course ${signed ? "weekly-grid-course--signed" : "weekly-grid-course--unsigned"}`}>
															<div className="weekly-grid-course__content"><div><h3>{course.courseName || "--"}</h3><span>{signed ? "已签到" : "未签到"}</span></div><p>{course.classroom || "教室待课表接口提供"}</p><p>{course.teacherName || "--"}</p>{signed ? <button type="button" disabled className="weekly-grid-course__action">已签到</button> : <button type="button" onClick={() => onCourseSign(course)} disabled={loading || signingThisCourse} className="weekly-grid-course__action">{signingThisCourse ? "签到中..." : "点击签到"}</button>}</div>
														</article>;
													}))}
												</div>
											</div>
										) : <div className="clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] px-4 py-8 text-center text-sm text-[color:var(--green)]"><p>本周暂无课程数据</p>{queryAttempted ? <p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">检查所选日期所在周是否为上课周，并确认学号与密码正确</p> : null}</div>
									) : filteredCourses.length === 0 ? (
										<div className="clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] px-4 py-8 text-center text-sm text-[color:var(--green)]">
											<p>当天暂无课程数据</p>
											{queryAttempted ? <p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">{emptyHelpText}</p> : null}
										</div>
									) : (
										<div className="daily-schedule-wrap overflow-x-auto rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)]">
											<div className="daily-schedule-header">
												<span>节次 / 时间</span>
												<span>{date} 当日课程</span>
											</div>
											<div className="daily-schedule-grid">
												{PERIODS.map((period) => (
													<div key={period.n} className="daily-schedule-period" style={{ gridRow: period.n }}>
														<strong>第 {period.n} 节</strong>
														<span>{period.t}</span>
													</div>
												))}
												{PERIODS.map((period) => <div key={`line-${period.n}`} className="daily-schedule-line" style={{ gridRow: period.n }} />)}
												{dailySchedule.scheduled.map(({ course, range }) => {
													const signed = course.signStatus === "1";
													const signingThisCourse = signingCourseUuid === course.uuid;
													return (
														<article key={`${course.id}-${course.uuid}`} style={{ gridRow: `${range.start} / ${range.end + 1}` }} className={`daily-schedule-course ${signed ? "daily-schedule-course--signed" : "daily-schedule-course--unsigned"}`}>
															<div className="flex items-start justify-between gap-2"><h3>{course.courseName || "--"}</h3><span>{signed ? "已签到" : "未签到"}</span></div>
															<p>{course.teacherName || "--"} · {course.classroom || "教室待课表接口提供"}</p>
															<p>{formatCoursePeriods(course)}</p>
															<button type="button" onClick={() => onCourseSign(course)} disabled={loading || signed || signingThisCourse} className="action-btn action-btn--primary mt-3 min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60">{signingThisCourse ? "签到中..." : signed ? "已签到" : "签到"}</button>
														</article>
													);
												})}
											</div>
										</div>
									)}
									{dailySchedule.unmatched.length > 0 ? <p className="text-xs text-[color:var(--muted)]">有 {dailySchedule.unmatched.length} 门课程的上课时间无法匹配至标准节次，未放入课表。</p> : null}

								</div>
							</div>
						</section>
					) : (
						<section
							id="main-content"
							className="grid items-start gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]"
						>
							<form onSubmit={onManualGenerate} className="panel rounded-2xl p-5 sm:p-6">
								<div className="space-y-1">
									<h2 className="font-[var(--font-serif)] text-2xl font-semibold">手动生成签到码</h2>
									<p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
										课程ID为7位纯数字，UUID为32位十六进制字符串
									</p>
								</div>

								<div className="mt-6 space-y-4">
									<label className="block text-sm font-semibold">
										课程ID / UUID
										<input
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="manualCourseIdentifier"
											value={manualIdentifier}
											onChange={(e) => setManualIdentifier(e.target.value)}
											placeholder="1203879 / EFD843630CE444769921BDDCD05298C7"
											autoComplete="off"
											spellCheck={false}
											required
										/>
									</label>

									<button
										disabled={manualLoading}
										className="action-btn action-btn--primary w-full rounded-xl px-4 py-3 text-sm font-semibold"
										type="submit"
									>
										{manualLoading ? "生成中..." : "生成签到码"}
									</button>
								</div>

							</form>

							<div
								ref={qrSectionRef}
								className={`render-skip clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface)] p-4 ${
									qrRelayActive ? "relay-highlight" : ""
								}`}
							>
								{hasQr ? (
									<div className="grid gap-4 lg:grid-cols-[220px_1fr] lg:items-center">
										<Image
											src={qrDataUrl}
											alt="签到码"
											width={220}
											height={220}
											unoptimized
											className="w-[220px] max-w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-raised)] p-2"
										/>
										<div className="space-y-3 text-sm numeric-tabular">
											<p>
												刷新倒计时：
												<span className="font-semibold">{expireCountdown}s</span>
											</p>
											<p className="break-all font-mono text-xs leading-6 text-[color:var(--muted)]">
												{signUrl}
											</p>
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													onClick={onDownloadQr}
													className="action-btn action-btn--secondary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
												>
													下载二维码
												</button>
												<button
													type="button"
													onClick={onCopySignUrl}
													className="action-btn action-btn--quiet min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
												>
													复制签到链接
												</button>
											</div>
										</div>
									</div>
								) : (
									<p className="text-sm text-center text-[color:var(--green)]">暂无签到码数据</p>
								)}
							</div>
						</section>
					)}
				</main>
			</div>
		</>
	);
}
