import React from 'react';
import { Mail, Phone, MapPin, ArrowLeft } from 'lucide-react';

export default function Contacts() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 text-white">
      <div className="container mx-auto px-4 py-8">
        <a
          href="/"
          className="inline-flex items-center text-purple-400 hover:text-purple-300 mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Назад
        </a>

        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold text-center mb-8 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            Контакты
          </h1>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-purple-500/20">
              <div className="flex items-center mb-4">
                <Mail className="w-6 h-6 text-purple-400 mr-3" />
                <h3 className="text-xl font-semibold">Email</h3>
              </div>
              <p className="text-gray-300">sowingrim@mail.ru</p>
              <p className="text-gray-400 text-sm mt-2">Для официальных обращений</p>
            </div>

            <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-purple-500/20">
              <div className="flex items-center mb-4">
                <Phone className="w-6 h-6 text-purple-400 mr-3" />
                <h3 className="text-xl font-semibold">Discord</h3>
              </div>
              <a
                href="https://discord.gg/9XYURMb5"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                discord.gg/9XYURMb5
              </a>
              <p className="text-gray-400 text-sm mt-2">Техническая поддержка</p>
            </div>

            <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-purple-500/20">
              <div className="flex items-center mb-4">
                <MapPin className="w-6 h-6 text-purple-400 mr-3" />
                <h3 className="text-xl font-semibold">Telegram</h3>
              </div>
              <a
                href="https://t.me/AuraClients"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                @AuraClients
              </a>
              <p className="text-gray-400 text-sm mt-2">Новости и обновления</p>
            </div>
          </div>

          <div className="mt-12 bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-purple-500/20">
            <h2 className="text-2xl font-semibold mb-6 text-purple-300">Реквизиты</h2>
            <div className="bg-gray-900/50 rounded-lg p-6 font-mono text-sm">
              <p className="text-gray-300 mb-2">
                <strong>Продавец:</strong> Игорь Глебов Александрович (самозанятый)
              </p>
              <p className="text-gray-300 mb-2">
                <strong>ИНН:</strong> 20639063753
              </p>
              <p className="text-gray-300 mb-2">
                <strong>Email:</strong> sowingrim@mail.ru
              </p>
              <p className="text-gray-300">
                <strong>Сайт:</strong> https://fade-visuals.vercel.app
              </p>
            </div>
          </div>

          <div className="mt-12 text-center">
            <p className="text-gray-400">Время работы поддержки: 10:00 - 22:00 (МСК)</p>
            <p className="text-gray-400 mt-2">Среднее время ответа: 15-30 минут</p>
          </div>
        </div>
      </div>
    </div>
  );
}
