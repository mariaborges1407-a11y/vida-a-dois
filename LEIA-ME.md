# Vida a Dois — app Android (APK) e iPhone

Este repositório compila **automaticamente**:

- **Android:** o ficheiro `vida-a-dois.apk`, publicado em **Releases**.
- **iPhone:** a app no endereço `https://O-SEU-UTILIZADOR.github.io/vida-a-dois/`, que se adiciona ao ecrã principal.

Sempre que um ficheiro é alterado, as duas versões são atualizadas sozinhas.

> O código não contém dados pessoais. Os dados ficam apenas nos telemóveis e passam de uma app para a outra através da cópia de segurança.

---

## 1. Criar o repositório (uma única vez)

1. Crie uma conta gratuita em **github.com**.
2. Carregue em **New repository**. Nome: `vida-a-dois`. Visibilidade: **Public**. Não marque nenhuma opção e carregue em **Create repository**.
3. Na página seguinte, carregue em **uploading an existing file**.
4. Descompacte o zip no computador, abra a pasta e **arraste todo o conteúdo** para a página do GitHub. Tem de incluir a pasta `.github`: sem ela, nada é compilado.
5. Carregue em **Commit changes**.

## 2. Guardar a chave de assinatura (uma única vez)

A chave garante que cada nova versão Android instala por cima da anterior, sem perder dados.

1. No repositório, abra **Settings → Secrets and variables → Actions → New repository secret**.
2. Crie os dois secrets indicados no ficheiro **SEGREDOS-NAO-PUBLICAR.txt**:
   - `KEYSTORE_BASE64`
   - `KEYSTORE_PASSWORD`

   Copie cada valor exatamente como está no ficheiro.
3. Guarde esse ficheiro num local seguro e **nunca o carregue no repositório**.

## 3. Ativar a página do iPhone (uma única vez)

- Abra **Settings → Pages**. Em **Source**, escolha **GitHub Actions**.

## 4. Compilar pela primeira vez

1. Abra o separador **Actions**.
2. Escolha **Compilar app Android** e carregue em **Run workflow**.
3. Escolha **Publicar app (iPhone)** e carregue em **Run workflow**.
4. Espere até aparecer o visto verde. A versão Android demora cerca de 5 minutos.

(As primeiras execuções automáticas, feitas logo após o carregamento, falham porque ainda não havia chave nem página configuradas. É normal.)

## 5. Passar os dados para as novas apps

**Antes de instalar**, na app atual de cada telemóvel, abra **Configurações → Exportar cópia** e guarde o ficheiro.

### Android (Bruno)

1. No telemóvel, abra o repositório no GitHub, depois **Releases** e descarregue `vida-a-dois.apk`.
2. Abra o ficheiro. Se o telemóvel pedir, autorize a instalação a partir desta origem.
3. Na app nova, abra **Configurações → Importar cópia** e escolha o ficheiro exportado.

### iPhone (Maria)

1. No Safari, abra `https://O-SEU-UTILIZADOR.github.io/vida-a-dois/`.
2. Carregue em **Partilhar** e depois em **Adicionar ao ecrã principal**.
3. Abra a app a partir do ecrã principal. Em **Configurações → Importar cópia**, escolha o ficheiro exportado.
4. Pode apagar o atalho antigo.

**Depois de importar**, confirme em **Configurações**:
- o **Utilizador deste telemóvel**;
- a **Escala de Bruno** (próxima chegada);
- o **Anel contracetivo** (próxima remoção).

Se não aparecerem preenchidos, indique-os e guarde.

## 6. Atualizações

1. No repositório, carregue os ficheiros novos da pasta `www` com **Add file → Upload files** e depois **Commit**.
2. O GitHub compila tudo sozinho.
   - **iPhone:** a app atualiza-se ao ser aberta duas vezes.
   - **Android:** descarregue o novo `vida-a-dois.apk` em Releases e instale por cima. Os dados mantêm-se.

## Notas

- **Notificações (Android):** em **Configurações → Lembretes → Ativar notificações**. Funcionam com a app fechada: dia 30 às 9h e datas do anel.
- **Notificações (iPhone):** use também **Adicionar ao calendário**, para ter alertas garantidos.
