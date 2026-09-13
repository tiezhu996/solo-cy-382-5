import { useState } from 'react';
import { Button, Form, Input, Modal, Space, Tag } from 'antd';
import { LockOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '../api';

export const TOKEN_KEY = 'token';
const NICKNAME_KEY = 'nickname';

interface LoginResult {
  token: string;
  user: { id: number; nickname: string };
}

/** 读取本地登录态（api.ts 会自动把 token 带到 Authorization 头） */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export default function BudgetAuthBar({ onAuthChange }: { onAuthChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ email: string; password: string; nickname?: string }>();
  const nickname = localStorage.getItem(NICKNAME_KEY);

  const close = () => {
    setOpen(false);
    form.resetFields();
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (mode === 'register') {
        await api('/users/register', {
          method: 'POST',
          body: JSON.stringify({ email: values.email, nickname: values.nickname ?? values.email, password: values.password })
        });
      }
      const result = await api<LoginResult | null>('/users/login', {
        method: 'POST',
        body: JSON.stringify({ email: values.email, password: values.password })
      });
      if (!result?.token) {
        Modal.error({ title: '登录失败', content: '邮箱或密码不正确，请重试' });
        return;
      }
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(NICKNAME_KEY, result.user.nickname);
      close();
      onAuthChange();
    } catch (err) {
      // 网络/服务器错误或注册冲突
      Modal.error({ title: mode === 'login' ? '登录失败' : '注册失败', content: err instanceof Error ? err.message : '请检查输入' });
    } finally {
      setSubmitting(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NICKNAME_KEY);
    onAuthChange();
  };

  return (
    <>
      <Space>
        {getToken() ? (
          <>
            <Tag icon={<UserOutlined />} color="blue">已登录：{nickname}</Tag>
            <Button size="small" icon={<LogoutOutlined />} onClick={logout}>退出</Button>
          </>
        ) : (
          <>
            <Tag color="orange">未登录（仅可查看，保存需行程发起者登录）</Tag>
            <Button size="small" type="primary" icon={<LockOutlined />} onClick={() => { setMode('login'); setOpen(true); }}>
              登录
            </Button>
          </>
        )}
      </Space>

      <Modal
        title={mode === 'login' ? '发起者登录' : '注册账号'}
        open={open}
        onCancel={close}
        confirmLoading={submitting}
        onOk={submit}
        okText={mode === 'login' ? '登录' : '注册并登录'}
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          {mode === 'register' && (
            <Form.Item name="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
              <Input placeholder="昵称" />
            </Form.Item>
          )}
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="you@example.com" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
        </Form>
        <Button
          type="link"
          style={{ padding: 0 }}
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
        </Button>
      </Modal>
    </>
  );
}
