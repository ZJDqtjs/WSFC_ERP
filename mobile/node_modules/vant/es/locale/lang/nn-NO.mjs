var stdin_default = {
  name: "Namn",
  tel: "Telefon",
  save: "Lagre",
  clear: "T\xF8m",
  undo: "Angre",
  cancel: "Avbryt",
  confirm: "Stadfest",
  delete: "Slett",
  loading: "Lastar...",
  noCoupon: "Ingen kupongar",
  nameEmpty: "Fyll inn namn",
  addContact: "Legg til ny kontakt",
  telInvalid: "Ugyldig telefonnummer",
  vanCalendar: {
    end: "Slutt",
    start: "Start",
    title: "Kalender",
    weekdays: ["Sun", "M\xE5n", "Tys", "Ons", "Tor", "Fre", "Lau"],
    monthTitle: (year, month) => `${year}/${month}`,
    rangePrompt: (maxRange) => `Maks. ${maxRange} dagar`
  },
  vanCascader: {
    select: "Vel"
  },
  vanPagination: {
    prev: "F\xF8rre",
    next: "Neste"
  },
  vanPullRefresh: {
    pulling: "Dra for \xE5 oppdatere...",
    loosing: "Slepp for \xE5 oppdatere..."
  },
  vanSubmitBar: {
    label: "Totalt:"
  },
  vanCoupon: {
    unlimited: "Ubegrensa",
    discount: (discount) => `${discount * 10}% avslag`,
    condition: (condition) => `Minst ${condition}`
  },
  vanCouponCell: {
    title: "Kupong",
    count: (count) => `Du har ${count} kupongar`
  },
  vanCouponList: {
    exchange: "Byt",
    close: "Lukk",
    enable: "Tilgjengeleg",
    disabled: "Utilgjengeleg",
    placeholder: "Kupongkode"
  },
  vanAddressEdit: {
    area: "Omr\xE5de",
    areaEmpty: "Vel omr\xE5de",
    addressEmpty: "Adressa kan ikkje vere tom",
    addressDetail: "Adresse",
    defaultAddress: "Set som standardadresse"
  },
  vanAddressList: {
    add: "Legg til ny adresse"
  }
};
export {
  stdin_default as default
};
