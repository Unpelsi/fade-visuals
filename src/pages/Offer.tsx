import React from 'react';
import { ArrowLeft } from 'lucide-react';

export default function Offer() {
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
            Публичная оферта
          </h1>

          <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-purple-500/20">
            <div className="prose prose-invert max-w-none">
              <p className="text-sm text-gray-500 mb-8">
                Настоящий документ является официальным предложением (офертой) самозанятого продавца.
                Дата публикации: {new Date().toLocaleDateString('ru-RU')}
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">1. Термины и определения</h2>
              <p className="text-gray-300 mb-6">
                1.1. «Продавец» — Игорь Глебов Александрович (самозанятый), ИНН 20639063753,
                предоставляющий доступ к программному обеспечению Aura Client.
              </p>
              <p className="text-gray-300 mb-6">
                1.2. «Покупатель» — физическое лицо, оплатившее доступ к программному обеспечению.
              </p>
              <p className="text-gray-300 mb-6">
                1.3. «Товар» — программное обеспечение Aura Client для Minecraft.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">2. Предмет договора</h2>
              <p className="text-gray-300 mb-6">
                2.1. Продавец предоставляет Покупателю доступ к программному обеспечению Aura Client,
                а Покупатель оплачивает выбранный тариф.
              </p>
              <p className="text-gray-300 mb-6">
                2.2. Доступ предоставляется в соответствии с выбранным тарифом: 1 месяц, навсегда или beta.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">3. Порядок оплаты</h2>
              <p className="text-gray-300 mb-6">
                3.1. Оплата производится через YooKassa доступными способами оплаты.
              </p>
              <p className="text-gray-300 mb-6">
                3.2. Моментом оплаты считается зачисление денежных средств Продавцу.
              </p>
              <p className="text-gray-300 mb-6">
                3.3. Все цены указаны в российских рублях.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">4. Передача доступа</h2>
              <p className="text-gray-300 mb-6">
                4.1. После подтверждения оплаты Покупатель получает доступ к Личному кабинету,
                где отображается лицензионный ключ.
              </p>
              <p className="text-gray-300 mb-6">
                4.2. Ключ предоставляется в электронном виде и может быть привязан к HWID устройства.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">5. Права и обязанности сторон</h2>
              <p className="text-gray-300 mb-6">
                5.1. Покупателю запрещается распространять, копировать и модифицировать программное обеспечение.
              </p>
              <p className="text-gray-300 mb-6">
                5.2. Продавец обязуется обеспечивать работоспособность сервиса и базовую техническую поддержку.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">6. Ответственность</h2>
              <p className="text-gray-300 mb-6">
                6.1. Использование программного обеспечения осуществляется на риск Покупателя.
              </p>
              <p className="text-gray-300 mb-6">
                6.2. Продавец не гарантирует отсутствия багов и не отвечает за блокировки игровых аккаунтов.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">7. Срок действия оферты</h2>
              <p className="text-gray-300 mb-6">
                7.1. Оферта действует до момента ее отзыва Продавцом.
              </p>

              <h2 className="text-2xl font-semibold mb-4 text-purple-300">8. Реквизиты и контакты</h2>
              <div className="bg-gray-900/50 rounded-lg p-4 font-mono text-sm">
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

              <p className="text-sm text-gray-400 mt-8 text-center">
                Актуальная версия оферты всегда доступна на сайте Продавца.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
