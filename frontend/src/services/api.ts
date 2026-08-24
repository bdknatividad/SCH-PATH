const API_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL ?? '/api')
  : '/api';

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // Get token from localStorage
  const token = localStorage.getItem('token');
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };
  
  // Add Authorization header if token exists
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
    headers,
    ...options,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  return payload;
}

export async function loginRequest(username: string, password: string) {
  const result = await request<{ success: boolean; data: { user: any; token: string } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  return result.data;
}

export async function getStore() {
  const result = await request<{ success: boolean; data: any }>('/store');
  return result.data;
}

export async function createResource<T>(resource: string, data: T) {
  const result = await request<{ success: boolean; data: T }>(`/${resource}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  return result.data;
}

export async function updateResource<T>(resource: string, id: string, data: Partial<T>) {
  const result = await request<{ success: boolean; data: T }>(`/${resource}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  return result.data;
}

export async function deleteResource(resource: string, id: string) {
  await request<{ success: boolean }>(`/${resource}/${id}`, {
    method: 'DELETE',
  });
}
