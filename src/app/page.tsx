"use client";

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

type StatusKind = "idle" | "loading" | "success" | "error" | "info";
type ScheduleView = "day" | "week";
type ToastState = { kind: Exclude<StatusKind, "idle">; message: string };

type WeekScheduleCache = {
	weekStart: string;
	cachedAt: number;
	days: WeekResponse["days"];
};

type SavedCredentials = {
	username: string;
	password: string;
};

const WEEK_SCHEDULE_CACHE_PREFIX = "ucas-week-schedule-cache-v1:";
const SAVED_CREDENTIALS_KEY = "ucas-saved-credentials-v1";
// UCAS 的 get_timestamp.do 与 stu_scan_sign.action 运行在不同服务器上，
// 两者时钟偏差约 3.5s。校准对齐了 timestamp API，需要减去缓冲才能被 sign API 接受。
const SIGN_TIMESTAMP_BUFFER_MS = 3 * 1000;

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

function readSavedCredentials(): SavedCredentials | null {
	try {
		const raw = window.localStorage.getItem(SAVED_CREDENTIALS_KEY);
		if (!raw) return null;
		const credentials = JSON.parse(raw) as SavedCredentials;
		if (typeof credentials.username !== "string" || typeof credentials.password !== "string" || !credentials.username.trim() || !credentials.password) {
			return null;
		}
		return { username: credentials.username.trim(), password: credentials.password };
	} catch {
		return null;
	}
}

function saveCredentials(username: string, password: string): void {
	try {
		window.localStorage.setItem(SAVED_CREDENTIALS_KEY, JSON.stringify({ username: username.trim(), password } satisfies SavedCredentials));
	} catch {}
}

function clearSavedCredentials(): void {
	try {
		window.localStorage.removeItem(SAVED_CREDENTIALS_KEY);
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

export default function Home() {
	const [username, setUsername] = useState(DEFAULT_TEST_USERNAME);
	const [password, setPassword] = useState(DEFAULT_TEST_PASSWORD);
	const [rememberCredentials, setRememberCredentials] = useState(false);
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [weeklyDays, setWeeklyDays] = useState<WeekResponse["days"]>([]);
	const [scheduleView, setScheduleView] = useState<ScheduleView>("week");
	const [weekCacheUpdatedAt, setWeekCacheUpdatedAt] = useState<number | null>(null);
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [toast, setToast] = useState<ToastState | null>(null);
	const [loading, setLoading] = useState(false);
	const [signingCourseUuid, setSigningCourseUuid] = useState("");
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
		const saved = readSavedCredentials();
		if (!saved) return;
		setUsername(saved.username);
		setPassword(saved.password);
		setRememberCredentials(true);
	}, []);

	useEffect(() => {
		if (!rememberCredentials || !username.trim() || !password) return;
		saveCredentials(username, password);
	}, [rememberCredentials, username, password]);

	useEffect(() => {
		return () => {
			if (toastTimerRef.current !== null) {
				window.clearTimeout(toastTimerRef.current);
			}
		};
	}, []);

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

	const onRememberCredentialsChange = (checked: boolean) => {
		setRememberCredentials(checked);
		if (!checked) {
			clearSavedCredentials();
			updateActionStatus("info", "已清除本机保存的账号和密码");
			return;
		}
		if (username.trim() && password) {
			saveCredentials(username, password);
			updateActionStatus("info", "账号和密码将仅保存在当前浏览器中");
		}
	};

	const onClearSavedCredentials = () => {
		clearSavedCredentials();
		setRememberCredentials(false);
		setUsername("");
		setPassword("");
		updateActionStatus("info", "已清除本机保存的账号和密码");
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
						<header className="mb-5">
							<a href="#main-content" className="sr-only focus:not-sr-only skip-link">
								跳到主要内容
							</a>
							{/* <div className="mt-4">
								<h1 className="max-w-4xl font-[var(--font-serif)] text-3xl leading-tight font-semibold sm:text-5xl">
									UCAS Course Sign in
								</h1>
							</div> */}
						</header>

						<section
							id="main-content"
							className="panel query-workspace rounded-2xl p-5 sm:p-6"
						>
							<form onSubmit={onSubmit}>
								<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
									<div>
											<h2 className="font-[var(--font-serif)] text-2xl font-semibold">查询本周课表</h2>
									{/* <p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
												默认查询当前日期所在周；可在下方选择仅在本机浏览器保存
									</p> */}
									</div>
								</div>
								{/* <div className="usage-disclaimer mt-4" role="note" aria-label="使用声明与本机凭据提示">
									<svg aria-hidden="true" viewBox="0 0 24 24">
										<path d="M12 8.25v4.5m0 3h.008M10.03 3.36 2.67 16.1A2.25 2.25 0 0 0 4.62 19.5h14.76a2.25 2.25 0 0 0 1.95-3.4L13.97 3.36a2.25 2.25 0 0 0-3.94 0Z" />
									</svg>
									<div>
										<strong>使用声明</strong>
										<p>开启“记住”后，账号和密码会以浏览器本地存储保存（未额外加密），可随时清除。</p>
									</div>
								</div> */}

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
										{/* <span className="date-hint">当前查询：{date}</span> */}
									</label>

									<button
										disabled={loading}
										className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-5 py-2.5 text-sm font-semibold md:w-auto"
										type="submit"
									>
											{loading ? "查询中..." : scheduleView === "week" ? "查询本周课表" : "查询当天课程"}
									</button>
								</div>
								<div className="credential-storage" aria-live="polite">
									<label className="credential-storage__toggle">
										<input
											type="checkbox"
											checked={rememberCredentials}
											onChange={(event) => onRememberCredentialsChange(event.target.checked)}
										/>
										<span>在这台设备记住账号和密码</span>
									</label>
									{rememberCredentials ? (
										<button type="button" onClick={onClearSavedCredentials} className="credential-storage__clear">
											清除本机保存信息
										</button>
									) : null}
									{/* <p>只适用于你本人可控制的浏览器；清除浏览器网站数据也会移除已保存信息。</p> */}
								</div>
								<div className="schedule-view-switch mt-3" role="group" aria-label="课表查询范围">
										<button type="button" onClick={() => { setScheduleView("week"); setCourses([]); setWeeklyDays([]); setWeekCacheUpdatedAt(null); updateStatus("idle", "将查询选定日期所在周（周一至周日）的课程"); }} className={scheduleView === "week" ? "schedule-view-switch__option schedule-view-switch__option--active" : "schedule-view-switch__option"} aria-pressed={scheduleView === "week"}>本周课表</button>
										<button type="button" onClick={() => { setScheduleView("day"); setCourses([]); setWeeklyDays([]); setWeekCacheUpdatedAt(null); updateStatus("idle", "将查询选定日期当天的课程"); }} className={scheduleView === "day" ? "schedule-view-switch__option schedule-view-switch__option--active" : "schedule-view-switch__option"} aria-pressed={scheduleView === "day"}>当日课表</button>
										{/* <span>{scheduleView === "week" ? "默认查询当前日期所在周（周一至周日）" : "仅查询所选日期"}</span> */}
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
															<div className="weekly-grid-course__content"><div><h3 title={course.courseName || ""}>{course.courseName || "--"}</h3><span>{signed ? "已签到" : "未签到"}</span></div><p>{course.classroom || "教室待课表接口提供"}</p><p>{course.teacherName || "--"}</p>{signed ? <button type="button" disabled className="weekly-grid-course__action">已签到</button> : <button type="button" onClick={() => onCourseSign(course)} disabled={loading || signingThisCourse} className="weekly-grid-course__action">{signingThisCourse ? "签到中..." : "点击签到"}</button>}</div>
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
												<span>节次</span>
												{/* <span>{date} 当日课程</span> */}
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
					</main>
			</div>
		</>
	);
}
