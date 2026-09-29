require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Login: siempre disponible
app.get('/login', (req, res) => {
  res.sendFile('login.html', { root: path.join(__dirname, 'public') });
});

// Servir la página principal (la verificación de sesión la hace el JS del cliente)
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, 'public') });
});

// ================= SCHEMAS & MODELS =================

// 1. Cliente con contador de servicios
const clientSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  telefono: { type: String, required: true },
  notas: { type: String, default: '' },
  contadorServicios: {
    type: Map,
    of: Number,
    default: {}
  }
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);

// 2. Citas / Agenda
const appointmentSchema = new mongoose.Schema({
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  clienteNombre: { type: String, required: true },
  clienteTelefono: { type: String, default: '' },
  servicio: { type: String, required: true },
  zonas: { type: [String], default: [] },
  valor: { type: Number, required: true },
  operaria: { type: String, required: true },
  fecha: { type: String, required: true }, // YYYY-MM-DD
  hora: { type: String, required: true }, // HH:MM
  duracion: { type: Number, default: 45 },
  estado: { type: String, enum: ['Pendiente', 'Listo para Facturar', 'Completada', 'Cancelada'], default: 'Pendiente' },
  notas: { type: String, default: '' },
  notasOperaria: { type: String, default: '' }
}, { timestamps: true });

const Appointment = mongoose.model('Appointment', appointmentSchema);

// 3. Movimientos de Caja y Ventas
const saleSchema = new mongoose.Schema({
  fecha: { type: String, required: true }, // YYYY-MM-DD
  hora: { type: String, required: true }, // HH:MM
  cliente: { type: String, required: true },
  concepto: { type: String, required: true },
  metodo: { type: String, enum: ['Efectivo', 'Tarjeta Débito', 'Tarjeta Crédito', 'Transferencia'], required: true },
  operaria: { type: String, default: 'General' },
  valor: { type: Number, required: true }
}, { timestamps: true });

const Sale = mongoose.model('Sale', saleSchema);

// 4. Configuración del Centro (Operarias, Servicios y Estado de Caja)
const configSchema = new mongoose.Schema({
  key: { type: String, default: 'main_config', unique: true },
  caja: {
    abierta: { type: Boolean, default: true },
    fondoInicial: { type: Number, default: 50000 },
    fechaApertura: { type: String, default: '' }
  },
  operarias: [{
    nombre: String,
    rol: String
  }],
  servicios: [{
    nombre: String,
    duracion: Number,
    precio: Number
  }]
});

const Config = mongoose.model('Config', configSchema);

// 5. Usuarios del Sistema y Roles (Control de Accesos)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  nombre: { type: String, required: true },
  rol: { type: String, enum: ['admin', 'recepcionista', 'operaria'], required: true },
  operariaNombre: { type: String, default: '' },
  activo: { type: Boolean, default: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// Helper para verificar usuario autenticado en peticiones
async function getAuthUser(req) {
  try {
    const userId = req.headers['x-user-id'];
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      const u = await User.findById(userId);
      if (u && u.activo) return u;
    }
    const roleHeader = req.headers['x-user-role'];
    if (roleHeader) {
      return { rol: roleHeader, nombre: 'Usuario Sesión' };
    }
  } catch (e) {
    console.error('Error al resolver usuario auth:', e);
  }
  return null;
}

// ================= UTILIDADES =================
function getFechaHoy() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Obtener o inicializar la configuración de forma 100% segura
async function getOrCreateConfig() {
  let config = await Config.findOne();
  if (!config) {
    config = await Config.create({
      key: 'main_config',
      caja: {
        abierta: true,
        fondoInicial: 50000,
        fechaApertura: getFechaHoy()
      },
      operarias: [
        { nombre: 'Valentina Restrepo', rol: 'Cosmiatra Especialista' },
        { nombre: 'Camila Morales', rol: 'Especialista Láser & Cejas' },
        { nombre: 'Mariana Duque', rol: 'Masoterapeuta' }
      ],
      servicios: [
        { nombre: 'Depilación Láser', duracion: 45, precio: 50000 },
        { nombre: 'Limpieza Facial Profunda', duracion: 60, precio: 95000 },
        { nombre: 'Masaje Reductor / Moldeador', duracion: 50, precio: 80000 },
        { nombre: 'Hydrafacial Glow', duracion: 60, precio: 150000 }
      ]
    });
  } else {
    let modificado = false;
    if (!config.operarias || !Array.isArray(config.operarias)) {
      config.operarias = [];
      modificado = true;
    }
    if (!config.servicios || !Array.isArray(config.servicios)) {
      config.servicios = [];
      modificado = true;
    }
    // Asegurar operarias de muestra si la lista está vacía
    if (config.operarias.length === 0) {
      config.operarias.push(
        { nombre: 'Valentina Restrepo', rol: 'Cosmiatra Especialista' },
        { nombre: 'Camila Morales', rol: 'Especialista Láser & Cejas' },
        { nombre: 'Mariana Duque', rol: 'Masoterapeuta' }
      );
      modificado = true;
    }
    // Asegurar que exista 'Depilación Láser' con precio base por zona de 50.000
    const tieneLaser = config.servicios.some(s => s.nombre && (s.nombre.toLowerCase().includes('laser') || s.nombre.toLowerCase().includes('láser')));
    if (!tieneLaser) {
      config.servicios.unshift({ nombre: 'Depilación Láser', duracion: 45, precio: 50000 });
      modificado = true;
    }
    if (modificado) {
      await config.save();
    }
  }
  return config;
}

// Inicializar configuración y datos semilla si la base está nueva
async function initDatabaseDefaults() {
  const config = await getOrCreateConfig();

  // Asegurar usuarios base
  const adminExists = await User.findOne({ rol: 'admin' });
  if (!adminExists) {
    await User.create({
      username: 'admin',
      password: 'admin123',
      nombre: 'Administrador General',
      rol: 'admin'
    });
    console.log('✓ Usuario Administrador creado: admin / admin123');
  }

  const recepcionExists = await User.findOne({ rol: 'recepcionista' });
  if (!recepcionExists) {
    await User.create({
      username: 'recepcion',
      password: 'recepcion123',
      nombre: 'Recepción & Caja',
      rol: 'recepcionista'
    });
    console.log('✓ Usuario Recepcionista creado: recepcion / recepcion123');
  }

  // Asegurar usuarios para las operarias registradas
  if (config.operarias && Array.isArray(config.operarias)) {
    for (const op of config.operarias) {
      const uname = op.nombre.split(' ')[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const opUser = await User.findOne({ username: uname });
      if (!opUser) {
        await User.create({
          username: uname,
          password: '123',
          nombre: op.nombre,
          rol: 'operaria',
          operariaNombre: op.nombre
        });
        console.log(`✓ Usuario Operaria creado: ${uname} / 123 (${op.nombre})`);
      }
    }
  }

  const clientCount = await Client.countDocuments();
  if (clientCount === 0) {
    const c1 = await Client.create({
      nombre: 'Carolina Gómez',
      telefono: '3104567890',
      notas: 'Piel mixta, sensible en zona T',
      contadorServicios: {
        'Depilación Láser': 4,
        'Láser: Bikini': 4,
        'Láser: Axilas': 4,
        'Limpieza Facial Profunda': 2
      }
    });

    const c2 = await Client.create({
      nombre: 'Laura Mendoza',
      telefono: '3209876543',
      notas: 'Plan 10 sesiones de masaje',
      contadorServicios: {
        'Masaje Reductor / Moldeador': 6,
        'Hydrafacial Glow': 1
      }
    });

    const c3 = await Client.create({
      nombre: 'Sofía Castaño',
      telefono: '3012345678',
      notas: 'Primera valoración',
      contadorServicios: {
        'Limpieza Facial Profunda': 1
      }
    });

    // Citas iniciales para hoy
    const hoy = getFechaHoy();
    await Appointment.create([
      {
        clienteId: c1._id,
        clienteNombre: c1.nombre,
        clienteTelefono: c1.telefono,
        servicio: 'Depilación Láser',
        zonas: ['Bikini', 'Axilas'],
        valor: 100000,
        operaria: 'Camila Morales',
        fecha: hoy,
        hora: '09:00',
        duracion: 45,
        estado: 'Completada',
        notas: 'Sesión #4 de paquete'
      },
      {
        clienteId: c2._id,
        clienteNombre: c2.nombre,
        clienteTelefono: c2.telefono,
        servicio: 'Masaje Reductor / Moldeador',
        zonas: [],
        valor: 80000,
        operaria: 'Mariana Duque',
        fecha: hoy,
        hora: '11:00',
        duracion: 50,
        estado: 'Pendiente',
        notas: 'Traer toalla personal'
      },
      {
        clienteId: c3._id,
        clienteNombre: c3.nombre,
        clienteTelefono: c3.telefono,
        servicio: 'Limpieza Facial Profunda',
        zonas: [],
        valor: 95000,
        operaria: 'Valentina Restrepo',
        fecha: hoy,
        hora: '14:30',
        duracion: 60,
        estado: 'Pendiente',
        notas: 'Valoración inicial'
      }
    ]);

    // Venta inicial registrada
    await Sale.create({
      fecha: hoy,
      hora: '09:50',
      cliente: c1.nombre,
      concepto: 'Depilación Láser (Bikini, Axilas)',
      metodo: 'Tarjeta Débito',
      operaria: 'Camila Morales',
      valor: 100000
    });

    console.log('✓ Datos iniciales de demostración cargados en MongoDB Atlas.');
  }
}

// ================= RUTAS API =================

// 1. Cargar todos los datos de inicio
app.get('/api/bootstrap', async (req, res) => {
  try {
    const hoy = getFechaHoy();
    const config = await getOrCreateConfig();
    const [clientes, todasLasCitas, ventasHoy, usuarios] = await Promise.all([
      Client.find().sort({ nombre: 1 }),
      Appointment.find().sort({ fecha: 1, hora: 1 }),
      Sale.find({ fecha: hoy }).sort({ createdAt: -1 }),
      User.find().select('-password').sort({ rol: 1, nombre: 1 })
    ]);

    res.json({
      success: true,
      data: {
        config,
        clientes,
        citas: todasLasCitas,
        ventas: ventasHoy,
        usuarios,
        fechaHoy: hoy
      }
    });
  } catch (error) {
    console.error('Error en bootstrap:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Crear Cliente
app.post('/api/clientes', async (req, res) => {
  try {
    const { nombre, telefono, notas } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del cliente es obligatorio' });
    }
    if (!telefono || !telefono.trim()) {
      return res.status(400).json({ success: false, error: 'El teléfono celular es obligatorio' });
    }
    const nuevo = await Client.create({
      nombre: nombre.trim(),
      telefono: telefono.trim(),
      notas: (notas || '').trim(),
      contadorServicios: {}
    });
    console.log(`✓ Nuevo cliente creado: ${nuevo.nombre} (${nuevo.telefono})`);
    res.json({ success: true, cliente: nuevo });
  } catch (error) {
    console.error('Error al crear cliente:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Crear Cita
app.post('/api/citas', async (req, res) => {
  try {
    const { clienteId, servicio, valor, operaria, fecha, hora, duracion, notas, zonas } = req.body;
    const cliente = await Client.findById(clienteId);
    if (!cliente) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });

    // Normalizar servicio si es Láser
    let nombreServicio = (servicio || 'Depilación Láser').trim();
    if (nombreServicio.toLowerCase().includes('laser') || nombreServicio.toLowerCase().includes('láser')) {
      nombreServicio = 'Depilación Láser';
    }

    // Si tiene zonas seleccionadas (Depilación Láser), el valor es 50.000 COP por zona
    let finalValor = Number(valor);
    if (zonas && Array.isArray(zonas) && zonas.length > 0) {
      finalValor = zonas.length * 50000;
    }

    const nuevaCita = await Appointment.create({
      clienteId: cliente._id,
      clienteNombre: cliente.nombre,
      clienteTelefono: cliente.telefono || '',
      servicio: nombreServicio,
      zonas: Array.isArray(zonas) ? zonas : [],
      valor: finalValor,
      operaria: operaria || 'General',
      fecha: fecha || getFechaHoy(),
      hora: hora || '10:00',
      duracion: Number(duracion) || 45,
      notas: (notas || '').trim(),
      estado: 'Pendiente'
    });

    console.log(`✓ Nueva cita agendada para: ${nuevaCita.clienteNombre} - ${nuevaCita.servicio} ($${nuevaCita.valor})`);
    res.json({ success: true, cita: nuevaCita });
  } catch (error) {
    console.error('Error al crear cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Reprogramar Cita
app.put('/api/citas/:id/reprogramar', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora, operaria } = req.body;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (hora) cita.hora = hora;
    if (operaria) cita.operaria = operaria;
    await cita.save();

    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al reprogramar cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4.1 Operaria: Actualizar Zonas y Enviar a Facturar en Recepción
app.put('/api/citas/:id/enviar-a-facturar', async (req, res) => {
  try {
    const { id } = req.params;
    const { zonas, notasOperaria } = req.body;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (zonas && Array.isArray(zonas)) {
      cita.zonas = zonas;
      if (cita.servicio && (cita.servicio.toLowerCase().includes('laser') || cita.servicio.toLowerCase().includes('láser'))) {
        cita.valor = zonas.length * 50000;
      }
    }
    if (notasOperaria !== undefined) {
      cita.notasOperaria = notasOperaria;
    }
    cita.estado = 'Listo para Facturar';
    await cita.save();

    console.log(`✓ Cita enviada a facturar en caja: ${cita.clienteNombre} (${cita.zonas.length} zonas) - $${cita.valor}`);
    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al enviar a facturar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4.2 Operaria: Actualizar Zonas en vivo
app.put('/api/citas/:id/actualizar-zonas', async (req, res) => {
  try {
    const { id } = req.params;
    const { zonas } = req.body;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (zonas && Array.isArray(zonas)) {
      cita.zonas = zonas;
      if (cita.servicio && (cita.servicio.toLowerCase().includes('laser') || cita.servicio.toLowerCase().includes('láser'))) {
        cita.valor = zonas.length * 50000;
      }
    }
    await cita.save();
    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al actualizar zonas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Cobrar y Completar Cita (¡Incrementa contador por zona y suma a caja!)
app.post('/api/citas/:id/completar-cobro', async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, metodo } = req.body;

    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    // Actualizar estado de cita
    cita.estado = 'Completada';
    await cita.save();

    // Incrementar CONTADOR de servicios del cliente en MongoDB
    const cliente = await Client.findById(cita.clienteId);
    if (cliente) {
      if (cita.zonas && cita.zonas.length > 0) {
        // Incrementar cada zona seleccionada (ej: "Láser: Bikini")
        cita.zonas.forEach(z => {
          const key = `Láser: ${z}`;
          const actual = cliente.contadorServicios.get(key) || 0;
          cliente.contadorServicios.set(key, actual + 1);
        });
        // Y el contador general de Depilación Láser
        const totalLaser = cliente.contadorServicios.get('Depilación Láser') || 0;
        cliente.contadorServicios.set('Depilación Láser', totalLaser + 1);
      } else {
        const actual = cliente.contadorServicios.get(cita.servicio) || 0;
        cliente.contadorServicios.set(cita.servicio, actual + 1);
      }
      await cliente.save();
    }

    // Registrar en Caja
    const now = new Date();
    const horaStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let concepto = cita.servicio;
    if (cita.zonas && cita.zonas.length > 0) {
      concepto = `${cita.servicio} (${cita.zonas.join(', ')})`;
    }

    const venta = await Sale.create({
      fecha: getFechaHoy(),
      hora: horaStr,
      cliente: cita.clienteNombre,
      concepto: concepto,
      metodo: metodo || 'Efectivo',
      operaria: cita.operaria,
      valor: Number(valor) || cita.valor
    });

    res.json({
      success: true,
      cita,
      cliente,
      venta
    });
  } catch (error) {
    console.error('Error al completar cobro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Apertura de Caja
app.post('/api/caja/apertura', async (req, res) => {
  try {
    const { fondoInicial } = req.body;
    let config = await getOrCreateConfig();
    config.caja.abierta = true;
    config.caja.fondoInicial = Number(fondoInicial) || 0;
    config.caja.fechaApertura = getFechaHoy();
    await config.save();

    res.json({ success: true, caja: config.caja });
  } catch (error) {
    console.error('Error en apertura de caja:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Cobro Rápido Manual en Caja
app.post('/api/caja/venta-rapida', async (req, res) => {
  try {
    const { cliente, concepto, metodo, operaria, valor } = req.body;
    const now = new Date();
    const horaStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const venta = await Sale.create({
      fecha: getFechaHoy(),
      hora: horaStr,
      cliente: cliente || 'Cliente General',
      concepto: concepto || 'Venta Rápida',
      metodo: metodo || 'Efectivo',
      operaria: operaria || 'General',
      valor: Number(valor) || 0
    });

    res.json({ success: true, venta });
  } catch (error) {
    console.error('Error en venta rápida:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7.1 Eliminar Venta de Caja (ESTRICTAMENTE SOLO ADMINISTRADOR)
app.delete('/api/caja/ventas/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado: El perfil Recepcionista u Operaria NO tiene autorización para eliminar ventas. Solo el Administrador tiene control total para anularlas.'
      });
    }

    const { id } = req.params;
    const venta = await Sale.findByIdAndDelete(id);
    if (!venta) {
      return res.status(404).json({ success: false, error: 'Venta no encontrada' });
    }

    console.log(`✓ Venta eliminada por Administrador: ${venta.concepto} ($${venta.valor}) de ${venta.cliente}`);
    res.json({ success: true, message: 'Venta eliminada exitosamente', venta });
  } catch (error) {
    console.error('Error al eliminar venta:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.delete('/api/ventas/:id', (req, res) => res.redirect(307, `/api/caja/ventas/${req.params.id}`));

// 8. Operarias: Crear y Eliminar (Solo Administrador)
app.post('/api/operarias', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede gestionar el equipo de operarias.' });
    }

    const { nombre, rol } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre de la operaria es obligatorio.' });
    }
    const config = await getOrCreateConfig();
    const nuevaOp = {
      nombre: nombre.trim(),
      rol: (rol && rol.trim()) ? rol.trim() : 'Operaria Especialista'
    };
    config.operarias.push(nuevaOp);
    await config.save();

    // Crear automáticamente usuario para la operaria
    const uname = nuevaOp.nombre.split(' ')[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const userExist = await User.findOne({ username: uname });
    if (!userExist) {
      await User.create({
        username: uname,
        password: '123',
        nombre: nuevaOp.nombre,
        rol: 'operaria',
        operariaNombre: nuevaOp.nombre
      });
      console.log(`✓ Usuario de operaria creado automáticamente: ${uname} / 123`);
    }

    console.log(`✓ Nueva operaria agregada: ${nuevaOp.nombre} (${nuevaOp.rol})`);
    res.json({ success: true, operarias: config.operarias });
  } catch (error) {
    console.error('Error al agregar operaria:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/operarias/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede eliminar operarias.' });
    }

    const config = await getOrCreateConfig();
    config.operarias = config.operarias.filter(o => o._id && o._id.toString() !== req.params.id);
    await config.save();
    console.log(`✓ Operaria eliminada id: ${req.params.id}`);
    res.json({ success: true, operarias: config.operarias });
  } catch (error) {
    console.error('Error al eliminar operaria:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Servicios: Crear y Eliminar (Solo Administrador - Recepcionista NO puede modificar precios)
app.post('/api/servicios', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado: El perfil Recepcionista NO tiene permisos para modificar precios o crear servicios. Solo el Administrador puede hacerlo.' });
    }

    const { nombre, duracion, precio } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del tratamiento es obligatorio.' });
    }
    const config = await getOrCreateConfig();
    const nuevoServ = {
      nombre: nombre.trim(),
      duracion: Number(duracion) || 45,
      precio: Number(precio) || 50000
    };
    config.servicios.push(nuevoServ);
    await config.save();
    console.log(`✓ Nuevo servicio agregado: ${nuevoServ.nombre} - $${nuevoServ.precio}`);
    res.json({ success: true, servicios: config.servicios });
  } catch (error) {
    console.error('Error al agregar servicio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/servicios/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado: Solo el Administrador puede eliminar o modificar tratamientos y precios.' });
    }

    const config = await getOrCreateConfig();
    config.servicios = config.servicios.filter(s => s._id && s._id.toString() !== req.params.id);
    await config.save();
    console.log(`✓ Servicio eliminado id: ${req.params.id}`);
    res.json({ success: true, servicios: config.servicios });
  } catch (error) {
    console.error('Error al eliminar servicio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= RUTAS DE AUTENTICACIÓN Y USUARIOS =================

// 10. Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Por favor ingresa usuario y contraseña' });
    }

    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user || !user.activo) {
      return res.status(401).json({ success: false, error: 'Usuario no encontrado o inactivo en el sistema.' });
    }

    if (user.password !== password.trim()) {
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta.' });
    }

    console.log(`✓ Inicio de sesión exitoso: ${user.username} (Rol: ${user.rol})`);
    res.json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        nombre: user.nombre,
        rol: user.rol,
        operariaNombre: user.operariaNombre
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. Listar Usuarios (Admin)
app.get('/api/usuarios', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede gestionar los accesos.' });
    }
    const usuarios = await User.find().select('-password').sort({ rol: 1, nombre: 1 });
    res.json({ success: true, usuarios });
  } catch (error) {
    console.error('Error al listar usuarios:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Crear Usuario (Admin)
app.post('/api/usuarios', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede crear usuarios.' });
    }

    const { username, password, nombre, rol, operariaNombre } = req.body;
    if (!username || !password || !nombre || !rol) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios.' });
    }

    const uname = username.toLowerCase().trim();
    const exist = await User.findOne({ username: uname });
    if (exist) {
      return res.status(400).json({ success: false, error: 'El nombre de usuario ya existe. Elige otro.' });
    }

    const nuevo = await User.create({
      username: uname,
      password: password.trim(),
      nombre: nombre.trim(),
      rol,
      operariaNombre: rol === 'operaria' ? (operariaNombre || nombre).trim() : ''
    });

    console.log(`✓ Nuevo usuario creado: ${nuevo.username} (${nuevo.rol})`);
    res.json({
      success: true,
      usuario: {
        _id: nuevo._id,
        username: nuevo.username,
        nombre: nuevo.nombre,
        rol: nuevo.rol,
        operariaNombre: nuevo.operariaNombre
      }
    });
  } catch (error) {
    console.error('Error al crear usuario:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 13. Eliminar Usuario (Admin)
app.delete('/api/usuarios/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede eliminar usuarios.' });
    }

    const { id } = req.params;
    if (authUser._id && authUser._id.toString() === id) {
      return res.status(400).json({ success: false, error: 'No puedes eliminar tu propia cuenta de Administrador.' });
    }

    await User.findByIdAndDelete(id);
    console.log(`✓ Usuario eliminado id: ${id}`);
    res.json({ success: true, message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= INICIAR SERVIDOR =================
async function startServer() {
  try {
    console.log('Conectando a MongoDB Atlas de HOME STHETIC...');
    await mongoose.connect(MONGODB_URI);
    console.log('✓ Conectado exitosamente a MongoDB Atlas.');

    await initDatabaseDefaults();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌸 HOME STHETIC ejecutándose en: http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Error fatal al iniciar:', error);
  }
}

startServer();
