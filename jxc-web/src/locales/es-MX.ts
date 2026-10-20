import type zhCN from './zh-CN'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : string }

/** 扩展语言包：一期只覆盖导航与通用文案，缺失的键回退到 zh-CN */
const esMX: DeepPartial<typeof zhCN> = {
  app: { title: 'Sistema de inventario y finanzas', short: 'HS Inventario' },
  common: {
    search: 'Buscar',
    reset: 'Limpiar',
    create: 'Nuevo',
    edit: 'Editar',
    save: 'Guardar',
    cancel: 'Cancelar',
    confirm: 'Confirmar',
    delete: 'Eliminar',
    disable: 'Desactivar',
    enable: 'Activar',
    actions: 'Acciones',
    status: 'Estado',
    detail: 'Detalle',
    auditLog: 'Bitácora',
    keyword: 'Palabra clave',
    total: '{n} registros',
    saved: 'Guardado',
    noData: 'Sin datos',
    back: 'Volver',
    next: 'Siguiente',
    prev: 'Anterior',
  },
  header: {
    country: 'País',
    testCountry: 'Prueba',
    todo: 'Pendientes',
    notifications: 'Avisos',
    logout: 'Cerrar sesión',
    resetMock: 'Restablecer datos demo',
    language: 'Idioma',
  },
  login: { title: 'Iniciar sesión', username: 'Usuario', password: 'Contraseña', submit: 'Entrar', demoAccounts: 'Cuentas demo' },
  menu: {
    group: {
      workbench: 'Inicio',
      purchase: 'Compras y logística',
      inventory: 'Inventario',
      sales: 'Ventas y tiendas',
      partners: 'Clientes y proveedores',
      cost: 'Costos y análisis',
      finance: 'Contabilidad',
      master: 'Catálogos',
      settings: 'Configuración',
    },
    workbench: 'Inicio',
    salesOrders: 'Pedidos de venta',
    stocks: 'Existencias',
    customers: 'Clientes',
    products: 'Productos',
  },
}

export default esMX
