import './style.css';
import { load } from './state';
import { mountUI } from './ui';

mountUI(document.getElementById('app')!, load());
