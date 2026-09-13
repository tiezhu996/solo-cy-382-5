export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // 登录后用户模块返回的 token 存于 localStorage；有则随请求带上，供后端 JwtGuard 校验
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    let code = 'REQUEST_FAILED';
    let message = `请求失败 ${response.status}`;
    try {
      const data = await response.json();
      if (data?.code) code = data.code;
      if (data?.message) message = data.message;
    } catch {
      // 非 JSON 错误响应时保留默认信息
    }
    throw new ApiError(response.status, code, message);
  }
  return response.json();
}
