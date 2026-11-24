import { Workshop } from './workshop/Workshop';
import { CONNECT, Connect } from './workshop/Connect';

export function App() {
  return location.pathname === CONNECT ? <Connect /> : <Workshop />;
}
