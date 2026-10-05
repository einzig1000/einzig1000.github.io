// スクリーンショットのクリックで拡大表示する
(() => {
  const dialog = document.getElementById("lightbox");
  if (!dialog || typeof dialog.showModal !== "function") return;
  const img = dialog.querySelector("img");

  document.querySelectorAll(".shot[data-full]").forEach((button) => {
    button.addEventListener("click", () => {
      const thumb = button.querySelector("img");
      img.src = button.dataset.full;
      img.alt = thumb ? thumb.alt : "";
      dialog.showModal();
    });
  });

  // 背景クリック・×ボタンで閉じる
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.closest(".lightbox-close")) dialog.close();
  });
})();

document.getElementById("year").textContent = new Date().getFullYear();
