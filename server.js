require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Login: siempre disponible
app.get('/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile('login.html', { root: path.join(__dirname, 'public') });
});

// Servir la página principal (la verificación de sesión la hace el JS del cliente)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile('index.html', { root: path.join(__dirname, 'public') });
});

// ================= SCHEMAS & MODELS =================

// 1. Cliente con contador de servicios e historia clínica
const clientSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  telefono: { type: String, required: true },
  notas: { type: String, default: '' },
  contadorServicios: {
    type: Map,
    of: Number,
    default: {}
  },
  historiaClinica: {
    preguntas: [{
      id: Number,
      pregunta: String,
      respuesta: { type: String, enum: ['SI', 'NO', 'NO_RESPONDE'], default: 'NO' }
    }],
    apta: { type: String, enum: ['APTA', 'NO_APTA', 'REQUIERE_VALORACION', 'PENDIENTE', 'AUTORIZADA_MEDICO', 'NO_AUTORIZADA_MEDICO'], default: 'PENDIENTE' },
    observaciones: { type: String, default: '' },
    fechaRegistro: { type: String, default: '' },
    registradoPor: { type: String, default: '' },
    autorizacionMedica: {
      estado: { type: String, enum: ['PENDIENTE', 'AUTORIZADA', 'NO_AUTORIZADA', 'REQUIERE_OBSERVACION'], default: 'PENDIENTE' },
      concepto: { type: String, default: '' },
      medicoNombre: { type: String, default: '' },
      fechaDictamen: { type: String, default: '' },
      horaDictamen: { type: String, default: '' }
    }
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
  tratamientosAdicionales: [{
    nombre: { type: String, required: true },
    precio: { type: Number, required: true },
    operaria: { type: String, default: '' },
    fecha: { type: String, default: '' }
  }],
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

// 3.1 Gastos y Egresos de Caja
const expenseSchema = new mongoose.Schema({
  fecha: { type: String, required: true }, // YYYY-MM-DD
  hora: { type: String, required: true },  // HH:MM
  concepto: { type: String, required: true },
  categoria: { 
    type: String, 
    default: 'Otros Gastos' 
  },
  metodo: { type: String, default: 'Efectivo' },
  responsable: { type: String, default: 'Recepción' },
  valor: { type: Number, required: true }
}, { timestamps: true });

const Expense = mongoose.model('Expense', expenseSchema);

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
  rol: { type: String, enum: ['admin', 'recepcionista', 'operaria', 'medico'], required: true },
  operariaNombre: { type: String, default: '' },
  activo: { type: Boolean, default: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// Helper para verificar usuario autenticado en peticiones
async function getAuthUser(req) {
  try {
    const userId = req.headers['x-user-id'] || req.query.user_id;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      const u = await User.findById(userId);
      if (u && u.activo) return u;
    }
    const roleHeader = req.headers['x-user-role'] || req.query.user_role;
    if (roleHeader) {
      return { rol: roleHeader, nombre: 'Usuario Sesión' };
    }
  } catch (e) {
    console.error('Error al resolver usuario auth:', e);
  }
  return null;
}

// ================= UTILIDADES =================
// Siempre usar la zona horaria oficial de Colombia (America/Bogota, UTC-5)
function getFechaHoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function getHoraActual() {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
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

  const medicoExists = await User.findOne({ rol: 'medico' });
  if (!medicoExists) {
    await User.create({
      username: 'doctor',
      password: '123',
      nombre: 'Dr. Alejandro Peña (Director Médico)',
      rol: 'medico'
    });
    console.log('✓ Usuario Médico creado: doctor / 123');
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
    const [clientes, todasLasCitas, ventasHoy, gastosHoy, usuarios] = await Promise.all([
      Client.find().sort({ nombre: 1 }),
      Appointment.find().sort({ fecha: 1, hora: 1 }),
      Sale.find({ fecha: hoy }).sort({ createdAt: -1 }),
      Expense.find({ fecha: hoy }).sort({ createdAt: -1 }),
      User.find().select('-password').sort({ rol: 1, nombre: 1 })
    ]);

    res.json({
      success: true,
      data: {
        config,
        clientes,
        citas: todasLasCitas,
        ventas: ventasHoy,
        gastos: gastosHoy,
        usuarios,
        fechaHoy: hoy
      }
    });
  } catch (error) {
    console.error('Error en bootstrap:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Crear Cliente (con Historia Clínica opcional/inicial)
app.post('/api/clientes', async (req, res) => {
  try {
    const { nombre, telefono, notas, historiaClinica } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del cliente es obligatorio' });
    }
    if (!telefono || !telefono.trim()) {
      return res.status(400).json({ success: false, error: 'El teléfono celular es obligatorio' });
    }

    const authUser = await getAuthUser(req);
    const nombreUsuario = authUser ? authUser.nombre : 'Recepción';

    let datosHistoria = null;
    if (historiaClinica && Array.isArray(historiaClinica.preguntas) && historiaClinica.preguntas.length > 0) {
      datosHistoria = {
        preguntas: historiaClinica.preguntas,
        apta: historiaClinica.apta || 'PENDIENTE',
        observaciones: (historiaClinica.observaciones || '').trim(),
        fechaRegistro: historiaClinica.fechaRegistro || new Date().toISOString().split('T')[0],
        registradoPor: historiaClinica.registradoPor || nombreUsuario
      };
    }

    const nuevo = await Client.create({
      nombre: nombre.trim(),
      telefono: telefono.trim(),
      notas: (notas || '').trim(),
      contadorServicios: {},
      historiaClinica: datosHistoria
    });
    console.log(`✓ Nuevo cliente creado: ${nuevo.nombre} (${nuevo.telefono}) [Aptitud Láser: ${nuevo.historiaClinica ? nuevo.historiaClinica.apta : 'Pendiente'}]`);
    res.json({ success: true, cliente: nuevo });
  } catch (error) {
    console.error('Error al crear cliente:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2.1 Actualizar Historia Clínica de un Cliente
app.put('/api/clientes/:id/historia-clinica', async (req, res) => {
  try {
    const { id } = req.params;
    const { preguntas, apta, observaciones } = req.body;

    const cliente = await Client.findById(id);
    if (!cliente) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });

    const authUser = await getAuthUser(req);
    const nombreUsuario = authUser ? authUser.nombre : 'Recepción';

    cliente.historiaClinica = {
      preguntas: Array.isArray(preguntas) ? preguntas : [],
      apta: apta || 'PENDIENTE',
      observaciones: (observaciones || '').trim(),
      fechaRegistro: new Date().toISOString().split('T')[0],
      registradoPor: nombreUsuario
    };

    await cliente.save();
    console.log(`✓ Historia clínica guardada para ${cliente.nombre}: ${cliente.historiaClinica.apta} por ${nombreUsuario}`);
    res.json({ success: true, cliente });
  } catch (error) {
    console.error('Error al guardar historia clínica:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2.2 Registrar Dictamen / Autorización Médica (Médico o Administrador)
app.put('/api/clientes/:id/autorizacion-medica', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || (authUser.rol !== 'medico' && authUser.rol !== 'admin')) {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado: Solo el perfil Médico o Administrador puede emitir autorizaciones clínicas.'
      });
    }

    const { id } = req.params;
    const { estado, concepto } = req.body; // 'AUTORIZADA', 'NO_AUTORIZADA', 'REQUIERE_OBSERVACION'

    const cliente = await Client.findById(id);
    if (!cliente) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });

    if (!cliente.historiaClinica) {
      cliente.historiaClinica = {
        preguntas: [],
        apta: 'PENDIENTE',
        observaciones: '',
        fechaRegistro: getFechaHoy(),
        registradoPor: authUser.nombre
      };
    }

    const fechaHoyStr = getFechaHoy();
    const horaActualStr = getHoraActual();

    cliente.historiaClinica.autorizacionMedica = {
      estado: estado || 'AUTORIZADA',
      concepto: (concepto || '').trim(),
      medicoNombre: authUser.nombre || 'Director Médico',
      fechaDictamen: fechaHoyStr,
      horaDictamen: horaActualStr
    };

    if (estado === 'AUTORIZADA') {
      cliente.historiaClinica.apta = 'AUTORIZADA_MEDICO';
    } else if (estado === 'NO_AUTORIZADA') {
      cliente.historiaClinica.apta = 'NO_AUTORIZADA_MEDICO';
    } else {
      cliente.historiaClinica.apta = 'REQUIERE_VALORACION';
    }

    await cliente.save();
    console.log(`✓ Dictamen médico registrado por ${authUser.nombre} para ${cliente.nombre}: ${cliente.historiaClinica.apta}`);
    res.json({ success: true, cliente });
  } catch (error) {
    console.error('Error al registrar autorización médica:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2.3 Eliminar Cliente (Solo Administrador)
app.delete('/api/clientes/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado: Solo el perfil Administrador puede eliminar clientes.'
      });
    }
    const { id } = req.params;
    const deleted = await Client.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
    console.log(`✓ Cliente eliminado por administrador: ${deleted.nombre}`);
    res.json({ success: true, message: 'Cliente eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar cliente:', error);
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

// 4. Reprogramar / Actualizar Cita
app.put('/api/citas/:id/reprogramar', async (req, res) => {
  try {
    const { id } = req.params;
    const { fecha, hora, operaria, estado } = req.body;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (fecha) cita.fecha = fecha;
    if (hora) cita.hora = hora;
    if (operaria) cita.operaria = operaria;
    if (estado) cita.estado = estado;
    await cita.save();

    console.log(`✓ Cita reprogramada: ${cita.clienteNombre} (${cita.fecha} ${cita.hora} - ${cita.operaria} [${cita.estado}])`);
    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al reprogramar cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4.0 Eliminar Cita (ESTRICTAMENTE SOLO ADMINISTRADOR)
app.delete('/api/citas/:id', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser || authUser.rol !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado: Solo el Administrador tiene autorización para eliminar citas de la agenda.'
      });
    }

    const { id } = req.params;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    await Appointment.findByIdAndDelete(id);
    console.log(`✓ Cita eliminada por Administrador (${authUser.nombre}): ${cita.clienteNombre} (${cita.fecha} ${cita.hora}) [Estado: ${cita.estado}]`);
    res.json({ success: true, message: 'Cita eliminada correctamente de la agenda' });
  } catch (error) {
    console.error('Error al eliminar cita:', error);
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
      const sNorm = (cita.servicio || '').toLowerCase();
      const sumaAdicionales = (cita.tratamientosAdicionales || []).reduce((acc, t) => acc + (t.precio || 0), 0);
      if (sNorm.includes('laser') || sNorm.includes('láser')) {
        cita.valor = (zonas.length * 50000) + sumaAdicionales;
      } else if (zonas.length > 0) {
        cita.servicio = 'Depilación Láser';
        cita.valor = (zonas.length * 50000) + sumaAdicionales;
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
      const sNorm = (cita.servicio || '').toLowerCase();
      const sumaAdicionales = (cita.tratamientosAdicionales || []).reduce((acc, t) => acc + (t.precio || 0), 0);
      if (sNorm.includes('laser') || sNorm.includes('láser')) {
        cita.valor = (zonas.length * 50000) + sumaAdicionales;
      } else if (zonas.length > 0) {
        cita.servicio = 'Depilación Láser';
        cita.valor = (zonas.length * 50000) + sumaAdicionales;
      }
    }
    await cita.save();
    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al actualizar zonas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4.3 Agregar Tratamiento Adicional a una Cita
app.post('/api/citas/:id/adicional', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, precio, operaria, modalidad } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del tratamiento adicional es obligatorio.' });
    }
    const monto = Number(precio);
    if (isNaN(monto) || monto < 0) {
      return res.status(400).json({ success: false, error: 'El precio debe ser un número válido mayor o igual a 0.' });
    }

    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (modalidad === 'nueva_cita') {
      const nueva = await Appointment.create({
        clienteId: cita.clienteId,
        clienteNombre: cita.clienteNombre,
        clienteTelefono: cita.clienteTelefono || '',
        servicio: nombre.trim(),
        zonas: [],
        tratamientosAdicionales: [],
        valor: monto,
        operaria: operaria || cita.operaria || 'General',
        fecha: cita.fecha,
        hora: cita.hora,
        duracion: 30,
        estado: 'Pendiente',
        notas: `Tratamiento adicional agendado junto a cita de ${cita.servicio}`
      });
      console.log(`✓ Cita adicional creada para ${cita.clienteNombre}: ${nombre} ($${monto})`);
      return res.json({ success: true, modo: 'nueva_cita', cita: nueva });
    }

    // Modalidad por defecto: sumar a la misma cita (cobro unificado)
    cita.tratamientosAdicionales = cita.tratamientosAdicionales || [];
    cita.tratamientosAdicionales.push({
      nombre: nombre.trim(),
      precio: monto,
      operaria: operaria || cita.operaria || 'General',
      fecha: getFechaHoy()
    });
    cita.valor = (cita.valor || 0) + monto;
    await cita.save();

    console.log(`✓ Tratamiento adicional sumado a cita de ${cita.clienteNombre}: ${nombre} (+$${monto}). Nuevo total: $${cita.valor}`);
    res.json({ success: true, modo: 'misma_cita', cita });
  } catch (error) {
    console.error('Error al agregar tratamiento adicional:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4.4 Eliminar Tratamiento Adicional de una Cita
app.delete('/api/citas/:id/adicional/:adicionalId', async (req, res) => {
  try {
    const { id, adicionalId } = req.params;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    const item = (cita.tratamientosAdicionales || []).id(adicionalId);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Tratamiento adicional no encontrado' });
    }

    const valorARestar = item.precio || 0;
    cita.valor = Math.max(0, (cita.valor || 0) - valorARestar);
    cita.tratamientosAdicionales.pull(adicionalId);
    await cita.save();

    console.log(`✓ Tratamiento adicional eliminado de cita ${cita.clienteNombre}: -$${valorARestar}. Nuevo total: $${cita.valor}`);
    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al eliminar tratamiento adicional:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Cobrar y Completar Cita (¡Incrementa contador por zona, por adicional y suma a caja!)
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

      // Incrementar contador para cada tratamiento adicional
      if (cita.tratamientosAdicionales && cita.tratamientosAdicionales.length > 0) {
        cita.tratamientosAdicionales.forEach(adic => {
          if (adic.nombre) {
            const actualAdic = cliente.contadorServicios.get(adic.nombre) || 0;
            cliente.contadorServicios.set(adic.nombre, actualAdic + 1);
          }
        });
      }

      await cliente.save();
    }

    // Registrar en Caja
    const horaStr = getHoraActual();
    let concepto = cita.servicio;
    if (cita.zonas && cita.zonas.length > 0) {
      concepto = `${cita.servicio} (${cita.zonas.join(', ')})`;
    }
    if (cita.tratamientosAdicionales && cita.tratamientosAdicionales.length > 0) {
      const extraTxt = cita.tratamientosAdicionales.map(t => `${t.nombre} ($${t.precio.toLocaleString('es-CO')})`).join(', ');
      concepto += ` + Adicional: ${extraTxt}`;
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
    const horaStr = getHoraActual();

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

// 7.2 Gastos: Registrar Gasto en Caja
app.post('/api/caja/gastos', async (req, res) => {
  try {
    const { concepto, categoria, metodo, valor, responsable } = req.body;
    if (!concepto || !concepto.trim()) {
      return res.status(400).json({ success: false, error: 'El concepto del gasto es obligatorio.' });
    }
    const monto = Number(valor);
    if (isNaN(monto) || monto <= 0) {
      return res.status(400).json({ success: false, error: 'El valor del gasto debe ser un número mayor a 0.' });
    }

    const authUser = await getAuthUser(req);
    const nombreResponsable = responsable || (authUser ? authUser.nombre : 'Recepción');

    const gasto = await Expense.create({
      fecha: getFechaHoy(),
      hora: getHoraActual(),
      concepto: concepto.trim(),
      categoria: categoria || 'Otros Gastos',
      metodo: metodo || 'Efectivo',
      responsable: nombreResponsable,
      valor: monto
    });

    console.log(`✓ Gasto registrado en caja: ${gasto.concepto} ($${gasto.valor}) [${gasto.metodo}] por ${gasto.responsable}`);
    res.json({ success: true, gasto });
  } catch (error) {
    console.error('Error al registrar gasto:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7.3 Gastos: Eliminar Gasto
app.delete('/api/caja/gastos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const gasto = await Expense.findByIdAndDelete(id);
    if (!gasto) {
      return res.status(404).json({ success: false, error: 'Gasto no encontrado' });
    }

    console.log(`✓ Gasto eliminado de caja: ${gasto.concepto} ($${gasto.valor})`);
    res.json({ success: true, message: 'Gasto eliminado exitosamente', gasto });
  } catch (error) {
    console.error('Error al eliminar gasto:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// ================= BACKUPS DE LA BASE DE DATOS (PROGRAMADO 7:00 PM) =================
const BACKUPS_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// Carpeta visible en el computador del usuario (Documentos -> Backups HOME STHETIC)
const USER_DOCS_BACKUPS_DIR = path.join(os.homedir(), 'Documents', 'Backups HOME STHETIC');
try {
  if (!fs.existsSync(USER_DOCS_BACKUPS_DIR)) {
    fs.mkdirSync(USER_DOCS_BACKUPS_DIR, { recursive: true });
  }
} catch (e) {
  console.log('Nota: Carpeta Documentos:', e.message);
}

// Exportar colecciones completas a objeto
async function exportarTodaLaBaseDeDatos() {
  const [clientes, citas, ventas, gastos, config, usuarios] = await Promise.all([
    Client.find().lean(),
    Appointment.find().lean(),
    Sale.find().lean(),
    Expense.find().lean(),
    Config.findOne({ key: 'main_config' }).lean(),
    User.find().select('-password').lean()
  ]);

  const now = new Date();
  const fechaISO = now.toISOString();
  const fechaLocal = now.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const horaLocal = now.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });

  return {
    sistema: 'HOME STHETIC CLINIC',
    version: '1.0.0',
    generadoEn: fechaISO,
    fechaLocal,
    horaLocal,
    zonaHoraria: 'America/Bogota',
    totalRegistros: {
      clientes: (clientes || []).length,
      citas: (citas || []).length,
      ventas: (ventas || []).length,
      gastos: (gastos || []).length,
      usuarios: (usuarios || []).length
    },
    data: {
      config: config || {},
      clientes: clientes || [],
      citas: citas || [],
      ventas: ventas || [],
      gastos: gastos || [],
      usuarios: usuarios || []
    }
  };
}

// Guardar copia en disco local del servidor y en la carpeta Documentos del PC
async function guardarBackupEnDisco(tipo = 'manual') {
  const backupData = await exportarTodaLaBaseDeDatos();
  const now = new Date();

  // Fecha y hora formateadas para el nombre de archivo (hora de Colombia)
  const d = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const timestampStr = `${d.year}-${d.month}-${d.day}_${d.hour}-${d.minute}-${d.second}`;
  const filename = `backup_homesthetic_${timestampStr}_${tipo}.json`;
  const filepath = path.join(BACKUPS_DIR, filename);

  // 1. Guardar en carpeta del servidor
  fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2), 'utf-8');
  const stats = fs.statSync(filepath);

  // 2. Guardar también directamente en la carpeta de Documentos del usuario en su PC
  try {
    if (fs.existsSync(USER_DOCS_BACKUPS_DIR)) {
      const userFilepath = path.join(USER_DOCS_BACKUPS_DIR, filename);
      fs.writeFileSync(userFilepath, JSON.stringify(backupData, null, 2), 'utf-8');
      console.log(`📂 [PC LOCAL] Copia guardada en Documentos: ${userFilepath}`);
    }
  } catch (errUser) {
    console.error('Error al guardar en carpeta Documentos del PC:', errUser.message);
  }

  console.log(`💾 [BACKUP] Copia de seguridad guardada con éxito: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);

  // Mantener los últimos 30 backups en ambas carpetas para optimizar espacio
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('backup_homesthetic_') && f.endsWith('.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 30) {
      files.slice(30).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, f.name)); } catch (e) {}
      });
    }

    if (fs.existsSync(USER_DOCS_BACKUPS_DIR)) {
      const userFiles = fs.readdirSync(USER_DOCS_BACKUPS_DIR)
        .filter(f => f.startsWith('backup_homesthetic_') && f.endsWith('.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(USER_DOCS_BACKUPS_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

      if (userFiles.length > 30) {
        userFiles.slice(30).forEach(f => {
          try { fs.unlinkSync(path.join(USER_DOCS_BACKUPS_DIR, f.name)); } catch (e) {}
        });
      }
    }
  } catch (err) {
    console.error('Error al depurar backups antiguos:', err);
  }

  return {
    filename,
    filepath,
    sizeBytes: stats.size,
    sizeKb: (stats.size / 1024).toFixed(1),
    fechaLocal: backupData.fechaLocal,
    horaLocal: backupData.horaLocal,
    totalRegistros: backupData.totalRegistros
  };
}

// Programador Cron: Todos los días a las 7:00 PM (19:00:00) hora de Colombia
function iniciarProgramadorBackups() {
  // '0 19 * * *' = 19:00 todos los días
  cron.schedule('0 19 * * *', async () => {
    console.log('⏰ [CRON 7:00 PM] Ejecutando copia de seguridad diaria programada...');
    try {
      const res = await guardarBackupEnDisco('automatico_7pm');
      console.log(`✓ [CRON 7:00 PM] Backup generado exitosamente: ${res.filename}`);
    } catch (err) {
      console.error('❌ [CRON 7:00 PM] Error en backup automático:', err);
    }
  }, {
    scheduled: true,
    timezone: 'America/Bogota'
  });

  console.log('⏰ Programador de Backups activado: Todos los días a las 7:00 PM (Hora Colombia America/Bogota)');
}

// Verificar si faltó un backup (por ejemplo, si a las 7:00 PM el equipo estaba apagado)
async function verificarYRecuperarBackupPendiente() {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return;
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('backup_homesthetic_') && f.endsWith('.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
      console.log('📦 Creando primera copia de seguridad del sistema...');
      await guardarBackupEnDisco('inicial_inicio_sistema');
      return;
    }

    const ultimoBackup = files[0];
    const tiempoTranscurridoHoras = (Date.now() - ultimoBackup.time) / (1000 * 60 * 60);

    // Si pasaron más de 20 horas desde el último respaldo (ej: PC apagado a las 7 PM),
    // se crea de inmediato la copia de seguridad de recuperación al iniciar el sistema
    if (tiempoTranscurridoHoras >= 20) {
      console.log(`⏰ [CATCHUP BACKUP] El último backup fue hace ${tiempoTranscurridoHoras.toFixed(1)}h. Se detectó equipo apagado en horario programado.`);
      console.log('🔄 Generando copia de seguridad de recuperación al encender el sistema...');
      const res = await guardarBackupEnDisco('recuperacion_al_encender');
      console.log(`✓ Copia de seguridad de recuperación creada: ${res.filename}`);
    }
  } catch (err) {
    console.error('Error al verificar backup pendiente:', err.message);
  }
}

// 14. Descargar backup directo en JSON (Admin)
app.get('/api/backup/descargar', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede descargar la copia de seguridad.' });
    }
    const backup = await exportarTodaLaBaseDeDatos();
    const fechaStr = new Date().toISOString().split('T')[0];
    const filename = `backup_homesthetic_${fechaStr}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error('Error al descargar backup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. Generar backup manual en servidor (Admin)
app.post('/api/backup/generar', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Solo el Administrador puede generar copias de seguridad.' });
    }
    const resultado = await guardarBackupEnDisco('manual_admin');
    res.json({ success: true, backup: resultado });
  } catch (err) {
    console.error('Error al generar backup manual:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 16. Listar historial de backups en el servidor (Admin)
app.get('/api/backup/listar', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado.' });
    }
    if (!fs.existsSync(BACKUPS_DIR)) {
      return res.json({ success: true, backups: [] });
    }
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('backup_homesthetic_') && f.endsWith('.json'))
      .map(f => {
        const p = path.join(BACKUPS_DIR, f);
        const stats = fs.statSync(p);
        return {
          filename: f,
          sizeKb: (stats.size / 1024).toFixed(1),
          creadoEn: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.creadoEn) - new Date(a.creadoEn));
    res.json({ success: true, backups: files });
  } catch (err) {
    console.error('Error al listar backups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 17. Descargar archivo de backup específico existente (Admin)
app.get('/api/backup/archivo/:filename', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado.' });
    }
    const safeName = path.basename(req.params.filename);
    const target = path.join(BACKUPS_DIR, safeName);
    if (!fs.existsSync(target)) {
      return res.status(404).json({ success: false, error: 'Archivo de backup no encontrado.' });
    }
    res.download(target, safeName);
  } catch (err) {
    console.error('Error al descargar archivo de backup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 18. Abrir carpeta de backups en el explorador de archivos del PC (Mac Finder / Windows Explorer)
app.post('/api/backup/abrir-carpeta', async (req, res) => {
  try {
    const authUser = await getAuthUser(req);
    if (authUser && authUser.rol !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado.' });
    }
    const targetDir = fs.existsSync(USER_DOCS_BACKUPS_DIR) ? USER_DOCS_BACKUPS_DIR : BACKUPS_DIR;
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? `open "${targetDir}"` :
                process.platform === 'win32' ? `explorer "${targetDir}"` : `xdg-open "${targetDir}"`;
    exec(cmd, (err) => {
      if (err) {
        return res.json({ success: false, error: 'No se pudo abrir la carpeta en el sistema: ' + err.message, path: targetDir });
      }
      res.json({ success: true, path: targetDir });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manejo de rutas API no encontradas
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// Middleware de manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no controlado:', err);
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, error: 'Identificador no válido para la operación.' });
  }
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Error interno del servidor'
  });
});

// Cierre limpio de conexiones (Graceful Shutdown)
process.on('SIGINT', async () => {
  console.log('\nCerrando servidor y desconectando MongoDB Atlas limpiamente...');
  try { await mongoose.disconnect(); } catch (e) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nCerrando servidor y desconectando MongoDB Atlas limpiamente...');
  try { await mongoose.disconnect(); } catch (e) {}
  process.exit(0);
});

// ================= INICIAR SERVIDOR =================
async function startServer() {
  try {
    console.log('Conectando a MongoDB Atlas de HOME STHETIC...');
    await mongoose.connect(MONGODB_URI);
    console.log('✓ Conectado exitosamente a MongoDB Atlas.');

    await initDatabaseDefaults();

    // Activar programador automático de copias de seguridad (7:00 PM)
    iniciarProgramadorBackups();

    // Comprobar y recuperar backup si el equipo estuvo apagado a las 7:00 PM
    await verificarYRecuperarBackupPendiente();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌸 HOME STHETIC ejecutándose en: http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Error fatal al iniciar:', error);
  }
}

startServer();
